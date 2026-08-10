'use strict';

const ts = require('typescript');
const { rules } = require('./rules');

/**
 * Directive prologue strings we care about.
 * Next.js recognizes: 'use cache', 'use cache: private', 'use cache: remote'
 */
const CACHE_DIRECTIVE_RE = /^use cache(:\s*(private|remote))?$/;

function getDirectiveKind(text) {
  const match = CACHE_DIRECTIVE_RE.exec(text.trim());
  if (!match) return null;
  return match[2] ? `use cache: ${match[2]}` : 'use cache';
}

/**
 * Reads the leading string-literal directive prologue statements of a
 * statement list (function body block or source file) and returns the
 * cache directive kind if present, or null.
 */
function getLeadingCacheDirective(statements) {
  for (const stmt of statements) {
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isStringLiteralLike(stmt.expression)
    ) {
      const kind = getDirectiveKind(stmt.expression.text);
      if (kind) return kind;
      // Some other directive (e.g. 'use strict') - keep scanning prologue.
      continue;
    }
    // First non-directive statement ends the prologue.
    break;
  }
  return null;
}

function nodeName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent || {}) && node.parent.name) {
    return node.parent.name.getText();
  }
  return '(anonymous)';
}

/**
 * Walks a scope's subtree collecting signals relevant to our rules:
 * - calls to cacheLife(...)
 * - calls to cacheTag(...)
 * - calls to cookies()/headers()
 * - references to an identifier named `searchParams`
 *
 * Stops descending into nested functions that declare their OWN
 * 'use cache' directive, since those are independent cache scopes.
 */
function collectSignals(root, sourceFile, helpers) {
  const signals = {
    hasCacheLife: false,
    hasCacheTag: false,
    dynamicApiCalls: [], // { name, line, viaChain? }
    searchParamsRefs: [], // { line }
  };

  function visit(node) {
    // Don't descend into a nested function that opens its own cache scope -
    // that's a separate scope with its own rules.
    if (node !== root && isFunctionLike(node)) {
      const body = node.body;
      if (body && ts.isBlock(body)) {
        const nested = getLeadingCacheDirective(body.statements);
        if (nested) {
          return; // independent scope, skip descending
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === 'cacheLife') signals.hasCacheLife = true;
      if (callee === 'cacheTag') signals.hasCacheTag = true;
      if (callee === 'cookies' || callee === 'headers') {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        signals.dynamicApiCalls.push({ name: callee, line: line + 1 });
      } else if (helpers.has(callee)) {
        const result = bodyTouchesDynamicApi(helpers.get(callee), helpers, new Set([callee]));
        if (result) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          signals.dynamicApiCalls.push({
            name: result.api,
            line: line + 1,
            viaChain: [callee, ...result.viaChain],
          });
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      node.text === 'searchParams' &&
      !isDeclarationName(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      signals.searchParamsRefs.push({ line: line + 1 });
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(root, visit);
  return signals;
}

function isDeclarationName(identifier) {
  const parent = identifier.parent;
  if (!parent) return false;
  return (
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier)
  );
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Collects top-level (module-scope) named functions declared in this file,
 * mapped to their body node. Skips functions that open their OWN 'use cache'
 * directive - those manage their own caching and are validated separately,
 * so calling them from another cache scope is not itself a leak signal.
 */
function collectTopLevelHelpers(sourceFile) {
  const helpers = new Map();

  function bodyOpensOwnCacheDirective(body) {
    return ts.isBlock(body) && !!getLeadingCacheDirective(body.statements);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      if (!bodyOpensOwnCacheDirective(stmt.body)) {
        helpers.set(stmt.name.text, stmt.body);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          decl.name &&
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) &&
          decl.initializer.body
        ) {
          const body = decl.initializer.body;
          if (!(ts.isBlock(body) && bodyOpensOwnCacheDirective(body))) {
            helpers.set(decl.name.text, body);
          }
        }
      }
    }
  }
  return helpers;
}

/**
 * Walks a function body (Block or expression body) looking for a call to
 * cookies()/headers(), a reference to `searchParams`, or a call to another
 * known helper that itself (transitively) touches one of those. Returns
 * `{ api, viaChain }` describing what was found and the chain of helper
 * names that led to it, or `null` if the body is clean.
 */
function bodyTouchesDynamicApi(bodyNode, helpers, visited) {
  let found = null;

  function visit(node) {
    if (found) return;

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === 'cookies' || callee === 'headers') {
        found = { api: callee, viaChain: [] };
        return;
      }
      if (helpers.has(callee) && !visited.has(callee)) {
        visited.add(callee);
        const nested = bodyTouchesDynamicApi(helpers.get(callee), helpers, visited);
        if (nested) {
          found = { api: nested.api, viaChain: [callee, ...nested.viaChain] };
          return;
        }
      }
    }

    if (ts.isIdentifier(node) && node.text === 'searchParams' && !isDeclarationName(node)) {
      found = { api: 'searchParams', viaChain: [] };
      return;
    }

    if (!found) ts.forEachChild(node, visit);
  }

  visit(bodyNode);
  return found;
}

/**
 * Scans one file's source text and returns a list of findings.
 * Each finding: { file, line, rule, severity, message }
 */
function scanSource(filePath, sourceText) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const helpers = collectTopLevelHelpers(sourceFile);

  /** Shared insertion point: right after the directive prologue statement. */
  function directiveInsertionPoint(statements) {
    const directiveStmt = statements[0];
    if (!directiveStmt) return null;
    const { character: indent } = sourceFile.getLineAndCharacterOfPosition(directiveStmt.getStart());
    return { insertPos: directiveStmt.getEnd(), indent };
  }

  function computeCacheLifeFix(statements) {
    const point = directiveInsertionPoint(statements);
    if (!point) return null;
    return { insertPos: point.insertPos, insertText: `\n${' '.repeat(point.indent)}cacheLife('minutes');` };
  }

  function computeCacheTagFix(statements, tagHint) {
    const point = directiveInsertionPoint(statements);
    if (!point) return null;
    return { insertPos: point.insertPos, insertText: `\n${' '.repeat(point.indent)}cacheTag('${tagHint}');` };
  }

  // Dispatch table: which fix computer to use for a given rule id. Rules
  // that add a `fixable: true` finding without an entry here simply won't
  // get a `.fix` attached (the CLI will report them but --fix will skip them).
  const fixComputers = {
    'missing-cache-life': (statements) => computeCacheLifeFix(statements),
    'missing-cache-tag': (statements, tagHint) => computeCacheTagFix(statements, tagHint),
  };

  function checkScope(root, kind, name, line, statements, tagHint) {
    const signals = collectSignals(root, sourceFile, helpers);
    const ctx = { kind, name, line, signals };

    for (const rule of rules) {
      const finding = rule.check(ctx);
      if (finding) {
        if (finding.fixable && fixComputers[finding.rule]) {
          finding.fix = fixComputers[finding.rule](statements, tagHint);
        }
        findings.push({ file: filePath, ...finding });
      }
    }
  }

  // 1) File-level directive (rare, but valid - applies to the whole module).
  const fileKind = getLeadingCacheDirective(sourceFile.statements);
  if (fileKind) {
    const fileTagHint = slugify(filePath.split('/').pop().replace(/\.(tsx?|jsx?)$/, ''));
    checkScope(sourceFile, fileKind, `${filePath} (module scope)`, 1, sourceFile.statements, fileTagHint);
  }

  // 2) Function/component-level directives.
  function visitTop(node) {
    if (isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
      const kind = getLeadingCacheDirective(node.body.statements);
      if (kind) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const name = nodeName(node);
        checkScope(node, kind, name, line + 1, node.body.statements, slugify(name));
      }
    }
    ts.forEachChild(node, visitTop);
  }
  visitTop(sourceFile);

  return findings;
}

/**
 * Turns a function/file name into a reasonable cacheTag() suggestion:
 * "getUserDashboard" -> "get-user-dashboard", "(anonymous)" -> "anonymous".
 */
function slugify(input) {
  const slug = input
    .replace(/[()]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  return slug || 'cache';
}

module.exports = { scanSource };
