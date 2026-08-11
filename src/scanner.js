'use strict';

const path = require('path');
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
function collectSignals(root, sourceFile, fileCtx, projectCtx) {
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
      } else {
        const resolved = resolveCalleeToBody(callee, fileCtx, projectCtx);
        if (resolved) {
          const crossedFile = resolved.fileCtx.absPath !== fileCtx.absPath ? resolved.fileCtx.absPath : null;
          const result = bodyTouchesDynamicApi(
            resolved.body,
            resolved.fileCtx,
            projectCtx,
            new Set([`${fileCtx.absPath}::${callee}`])
          );
          if (result) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            signals.dynamicApiCalls.push({
              name: result.api,
              line: line + 1,
              viaChain: [{ name: callee, file: crossedFile }, ...result.viaChain],
            });
          }
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
 * Collects the names of top-level declarations that carry an `export`
 * modifier - these are the only names another file could import.
 */
function collectExportedNames(sourceFile) {
  const names = new Set();
  for (const stmt of sourceFile.statements) {
    const hasExportModifier = !!(
      stmt.modifiers && stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
    if (!hasExportModifier) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.name && ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
  }
  return names;
}

/**
 * Maps each locally-bound import name to where it came from:
 * `import { getSession as gs } from './auth'` -> gs -> { importedName: 'getSession', modulePath: './auth' }
 * `import auth from './auth'` -> auth -> { importedName: 'default', modulePath: './auth' }
 * Namespace imports (`import * as ns`) are not tracked - a rare pattern for
 * small helper functions, and out of scope for v1.
 */
function collectImportMap(sourceFile) {
  const importMap = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modulePath = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;

    if (clause.name) {
      importMap.set(clause.name.text, { importedName: 'default', modulePath });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const importedName = el.propertyName ? el.propertyName.text : el.name.text;
        importMap.set(el.name.text, { importedName, modulePath });
      }
    }
  }
  return importMap;
}

/**
 * Given a resolved base path (no extension), tries common TS/JS extension
 * and index-file fallbacks and returns the one present in `registry`.
 */
function candidateExtensions(base, registry) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((c) => registry.has(c)) || null;
}

/**
 * Resolves a relative import specifier (e.g. './auth') from `fromAbsPath`
 * to an absolute path present in `registry`.
 */
function resolveRelativeImport(fromAbsPath, modulePath, registry) {
  if (!modulePath.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbsPath), modulePath);
  return candidateExtensions(base, registry);
}

/**
 * Resolves an import specifier to an absolute file in the registry, trying
 * (in order): a relative import (`./`, `../`), then - if the project has a
 * tsconfig `paths` alias resolver (e.g. `@/*` -> `./*`, the most common
 * Next.js convention) - an aliased import. Bare package imports (npm
 * packages) resolve to null on both counts and are correctly left untraced.
 */
function resolveModuleSpecifier(fromAbsPath, modulePath, projectCtx) {
  if (!projectCtx) return null;
  const relative = resolveRelativeImport(fromAbsPath, modulePath, projectCtx.registry);
  if (relative) return relative;
  if (projectCtx.resolveAlias) {
    const aliasedBase = projectCtx.resolveAlias(modulePath);
    if (aliasedBase) return candidateExtensions(aliasedBase, projectCtx.registry);
  }
  return null;
}

/**
 * Parses one file into the lightweight metadata needed for cross-file
 * tracing: its top-level function bodies (for same-file recursion once we
 * land here), which of those are exported (importable by other files), and
 * what it imports from where. Used to build a project-wide registry before
 * any rule-checking happens, so files that don't themselves contain
 * 'use cache' can still be traced into as helper modules.
 */
function parseFileMeta(absPath, sourceText) {
  const sourceFile = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  return {
    absPath,
    allTopLevel: collectTopLevelHelpers(sourceFile),
    exportedNames: collectExportedNames(sourceFile),
    importMap: collectImportMap(sourceFile),
  };
}

/**
 * Given a callee name referenced inside `fileCtx`, finds where its body
 * actually lives: a same-file top-level function, or - if a project
 * registry is available - a function imported (transitively resolvable,
 * relatively or via a tsconfig path alias) from another local file. Returns
 * null if it can't be resolved (e.g. an external library call, or a name we
 * don't recognize).
 */
function resolveCalleeToBody(name, fileCtx, projectCtx) {
  if (fileCtx.allTopLevel.has(name)) {
    return { body: fileCtx.allTopLevel.get(name), fileCtx };
  }
  if (projectCtx && fileCtx.importMap.has(name)) {
    const { importedName, modulePath } = fileCtx.importMap.get(name);
    const resolvedPath = resolveModuleSpecifier(fileCtx.absPath, modulePath, projectCtx);
    if (resolvedPath) {
      const target = projectCtx.registry.get(resolvedPath);
      if (target && target.exportedNames.has(importedName) && target.allTopLevel.has(importedName)) {
        return { body: target.allTopLevel.get(importedName), fileCtx: target };
      }
    }
  }
  return null;
}

/**
 * Walks a function body (Block or expression body) looking for a call to
 * cookies()/headers(), a reference to `searchParams`, or a call to another
 * known helper - same-file, or (with a project registry) imported from
 * another local file - that itself (transitively) touches one of those.
 * Returns `{ api, viaChain }` where viaChain is an array of
 * `{ name, file }` describing the call path, or `null` if clean.
 * `visited` guards against cycles, including across files.
 */
function bodyTouchesDynamicApi(bodyNode, fileCtx, projectCtx, visited) {
  let found = null;

  function visit(node) {
    if (found) return;

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === 'cookies' || callee === 'headers') {
        found = { api: callee, viaChain: [] };
        return;
      }
      const visitKey = `${fileCtx.absPath}::${callee}`;
      if (!visited.has(visitKey)) {
        const resolved = resolveCalleeToBody(callee, fileCtx, projectCtx);
        if (resolved) {
          visited.add(visitKey);
          const nested = bodyTouchesDynamicApi(resolved.body, resolved.fileCtx, projectCtx, visited);
          if (nested) {
            const crossedFile = resolved.fileCtx.absPath !== fileCtx.absPath ? resolved.fileCtx.absPath : null;
            found = {
              api: nested.api,
              viaChain: [{ name: callee, file: crossedFile }, ...nested.viaChain],
            };
            return;
          }
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
function scanSource(filePath, sourceText, projectCtx) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const helpers = collectTopLevelHelpers(sourceFile);
  const absPath = (projectCtx && projectCtx.absPath) || path.resolve(filePath);
  const fileCtx = { absPath, allTopLevel: helpers, importMap: collectImportMap(sourceFile) };

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
    const signals = collectSignals(root, sourceFile, fileCtx, projectCtx);
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

module.exports = { scanSource, parseFileMeta };
