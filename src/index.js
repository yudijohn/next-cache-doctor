'use strict';

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const { scanSource, parseFileMeta } = require('./scanner');

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/coverage/**',
];

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
  for (const absPath of entries) {
    const text = fs.readFileSync(absPath, 'utf8');
    fileTexts.set(absPath, text);
    try {
      registry.set(absPath, parseFileMeta(absPath, text));
    } catch (err) {
      // Unparseable file (e.g. a syntax error) - skip it for cross-file
      // tracing purposes. If it also contains 'use cache' text, pass 2
      // will surface the parse failure on its own.
    }
  }

  // Pass 2: actually run the rules, but only on files that mention
  // 'use cache' at all (fast skip - most files in a project won't).
  let findings = [];
  let filesWithCache = 0;

  for (const absPath of entries) {
    const text = fileTexts.get(absPath);
    if (!text.includes('use cache')) continue;
    const relPath = path.relative(cwd, absPath);
    const fileFindings = scanSource(relPath, text, { absPath, registry });
    if (fileFindings.length > 0 || text.match(/['"]use cache/)) {
      filesWithCache += 1;
    }
    findings = findings.concat(fileFindings);
  }

  return {
    findings,
    filesScanned: entries.length,
    filesWithCache,
  };
}

module.exports = { runScan };
