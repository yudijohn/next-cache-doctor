'use strict';

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const { scanSource } = require('./scanner');

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

  let findings = [];
  let filesWithCache = 0;

  for (const absPath of entries) {
    const text = fs.readFileSync(absPath, 'utf8');
    if (!text.includes('use cache')) continue; // fast skip, avoids parsing every file
    const relPath = path.relative(cwd, absPath);
    const fileFindings = scanSource(relPath, text);
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
