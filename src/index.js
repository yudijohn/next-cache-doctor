'use strict';

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const { scanSource, parseFileMeta, collectTagUsageFromText } = require('./scanner');
const unmatchedRevalidateTag = require('./rules/unmatched-revalidate-tag');

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/coverage/**',
];

/**
 * Reads tsconfig.json's `compilerOptions.paths` (the standard way Next.js
 * projects configure import aliases like `@/*` -> `./*`) and returns a
 * resolver function mapping an aliased specifier to an absolute base path,
 * or null if there's no tsconfig / no usable `paths` entries. Only simple
 * wildcard patterns ("prefix/*" -> "target/*") are supported - covers the
 * overwhelming majority of real-world configs.
 */
function loadAliasResolver(cwd) {
  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  let parsed;
  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    // tsconfig.json commonly allows comments (JSONC) - strip them defensively.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"])\/\/.*$/gm, '$1');
    parsed = JSON.parse(stripped);
  } catch (err) {
    return null;
  }

  const compilerOptions = parsed.compilerOptions || {};
  if (!compilerOptions.paths) return null;

  const baseUrl = compilerOptions.baseUrl || '.';
  const tsconfigDir = path.dirname(tsconfigPath);
  const entries = [];
  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    if (!pattern.endsWith('/*') || !Array.isArray(targets) || !targets[0] || !targets[0].endsWith('/*')) {
      continue; // exotic (non-wildcard) alias patterns are out of scope for v1
    }
    entries.push({ prefix: pattern.slice(0, -2), targetPrefix: targets[0].slice(0, -2) });
  }
  if (entries.length === 0) return null;

  return function resolveAlias(specifier) {
    for (const { prefix, targetPrefix } of entries) {
      if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
        const rest = specifier.slice(prefix.length);
        return path.resolve(tsconfigDir, baseUrl, `${targetPrefix}${rest}`);
      }
    }
    return null;
  };
}

/**
 * Runs the scan against a target directory.
 * @param {string} targetDir
 * @param {{ ignore?: string[] }} [opts]
 * @returns {{ findings: Array, filesScanned: number, filesWithCache: number }}
 */
async function runScan(targetDir, opts = {}) {
  const cwd = path.resolve(targetDir);
  if (!fs.existsSync(cwd)) {
    throw new Error(`Path not found: ${cwd}`);
  }

  const entries = await fg(['**/*.ts', '**/*.tsx'], {
    cwd,
    ignore: DEFAULT_IGNORE.concat(opts.ignore || []),
    absolute: true,
    dot: false,
  });

  // Pass 1: build a project-wide registry of every file's top-level
  // functions, exports, and imports. This has to cover ALL matched files -
  // not just ones containing 'use cache' - because a helper module that
  // itself has no cache directive can still be imported and called from a
  // cache scope elsewhere, and the leak rule needs to be able to trace
  // into it.
  const fileTexts = new Map();
  const registry = new Map();
  const resolveAlias = loadAliasResolver(cwd);
  const globalCacheTagShapes = new Set();
  const globalRevalidateCalls = []; // { file (abs), line, shape, displayText, calleeName }

  for (const absPath of entries) {
    const text = fs.readFileSync(absPath, 'utf8');
    fileTexts.set(absPath, text);
    try {
      registry.set(absPath, parseFileMeta(absPath, text));

      // Tag usage (cacheTag / revalidateTag / updateTag) has to be
      // collected from EVERY file, not just ones containing 'use cache' -
      // a Server Action or Route Handler that calls revalidateTag()
      // commonly has no cache scope of its own.
      const { cacheTagShapes, revalidateCalls } = collectTagUsageFromText(absPath, text);
      cacheTagShapes.forEach((shape) => globalCacheTagShapes.add(shape));
      globalRevalidateCalls.push(...revalidateCalls);
    } catch (err) {
      // Unparseable file (e.g. a syntax error) - skip it for cross-file
      // tracing and tag-matching purposes. If it also contains 'use cache'
      // text, pass 2 will surface the parse failure on its own.
    }
  }

  // Pass 2: actually run the per-scope rules, but only on files that
  // mention 'use cache' at all (fast skip - most files in a project won't).
  let findings = [];
  let filesWithCache = 0;

  for (const absPath of entries) {
    const text = fileTexts.get(absPath);
    if (!text.includes('use cache')) continue;
    const relPath = path.relative(cwd, absPath);
    const fileFindings = scanSource(relPath, text, { absPath, registry, resolveAlias });
    if (fileFindings.length > 0 || text.match(/['"]use cache/)) {
      filesWithCache += 1;
    }
    findings = findings.concat(fileFindings);
  }

  // Pass 3: project-wide rules that can't be evaluated per-file, since they
  // need to see every file's tag usage before they can judge any single
  // call site. Convert absolute paths back to the same relative-path style
  // used by the rest of the findings for consistent CLI output.
  const projectFindings = unmatchedRevalidateTag.checkProject({
    revalidateCalls: globalRevalidateCalls.map((call) => ({
      ...call,
      file: path.relative(cwd, call.file),
    })),
    cacheTagShapes: globalCacheTagShapes,
  });
  findings = findings.concat(projectFindings);

  return {
    findings,
    filesScanned: entries.length,
    filesWithCache,
  };
}

module.exports = { runScan };
