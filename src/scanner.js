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
function collectSignals(root, sourceFile) {
  const signals = {
    hasCacheLife: false,
    hasCacheTag: false,
    dynamicApiCalls: [], // { name, line }
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

  function checkScope(root, kind, name, line) {
    const signals = collectSignals(root, sourceFile);
    const ctx = { kind, name, line, signals };

    for (const rule of rules) {
      const finding = rule.check(ctx);
      if (finding) {
        findings.push({ file: filePath, ...finding });
      }
    }
  }

  // 1) File-level directive (rare, but valid - applies to the whole module).
  const fileKind = getLeadingCacheDirective(sourceFile.statements);
  if (fileKind) {
    checkScope(sourceFile, fileKind, `${filePath} (module scope)`, 1);
  }

  // 2) Function/component-level directives.
  function visitTop(node) {
    if (isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
      const kind = getLeadingCacheDirective(node.body.statements);
      if (kind) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        checkScope(node, kind, nodeName(node), line + 1);
      }
    }
    ts.forEachChild(node, visitTop);
  }
  visitTop(sourceFile);

  return findings;
}

module.exports = { scanSource };
