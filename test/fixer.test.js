'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scanSource } = require('../src/scanner');
const { applyFixes } = require('../src/fixer');

function withTempFile(content, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd-fixer-'));
  const file = 'sample.tsx';
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
  try {
    run(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('missing-cache-tag findings are marked fixable with a slugified tag suggestion', () => {
  const src = `
    import { cacheLife } from 'next/cache';
    export async function getUserSettings() {
      'use cache';
      cacheLife('hours');
      return fetchSettings();
    }
  `;
  const findings = scanSource('x.tsx', src);
  const tagFinding = findings.find((f) => f.rule === 'missing-cache-tag');
  assert.ok(tagFinding);
  assert.equal(tagFinding.fixable, true);
});

test('--fix inserts both cacheLife and cacheTag in the right order when both are missing', () => {
  withTempFile(
    `export async function getProducts() {\n  'use cache';\n  return fetch('/api/products');\n}\n`,
    (dir, file) => {
      const before = fs.readFileSync(path.join(dir, file), 'utf8');
      const findings = scanSource(file, before);
      applyFixes(dir, findings);
      const after = fs.readFileSync(path.join(dir, file), 'utf8');

      assert.match(after, /'use cache';\s*\n\s*cacheLife\('minutes'\);\s*\n\s*cacheTag\('get-products'\);/);

      // The fixed file should now be clean.
      const rescanFindings = scanSource(file, after);
      assert.equal(rescanFindings.length, 0);
    }
  );
});

test('--fix suggests a slugified tag name derived from a const arrow function', () => {
  withTempFile(
    `export const getData = async () => {\n  'use cache';\n  return fetch('/api/data');\n};\n`,
    (dir, file) => {
      const before = fs.readFileSync(path.join(dir, file), 'utf8');
      const findings = scanSource(file, before);
      applyFixes(dir, findings);
      const after = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.match(after, /cacheTag\('get-data'\)/);
    }
  );
});

test('--fix only inserts cacheTag when cacheLife is already present', () => {
  withTempFile(
    `import { cacheLife } from 'next/cache';\n\nexport async function getUserSettings() {\n  'use cache';\n  cacheLife('hours');\n  return fetchSettings();\n}\n`,
    (dir, file) => {
      const before = fs.readFileSync(path.join(dir, file), 'utf8');
      const findings = scanSource(file, before);
      applyFixes(dir, findings);
      const after = fs.readFileSync(path.join(dir, file), 'utf8');

      // cacheLife('hours') should be untouched, not duplicated or overwritten.
      const lifeMatches = after.match(/cacheLife\(/g) || [];
      assert.equal(lifeMatches.length, 1);
      assert.match(after, /cacheLife\('hours'\)/);
      assert.match(after, /cacheTag\('get-user-settings'\)/);
    }
  );
});
