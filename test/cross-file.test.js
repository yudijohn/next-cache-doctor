'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runScan } = require('../src/index');

function withTempProject(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd-crossfile-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('traces a leak through a helper imported from another file', async () => {
  await withTempProject(
    {
      'lib/auth.ts': `
        import { cookies } from 'next/headers';
        export function getSession() {
          return cookies().get('session')?.value;
        }
      `,
      'dashboard.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { getSession } from './lib/auth';

        export async function getUserDashboard() {
          'use cache';
          cacheLife('minutes');
          cacheTag('dashboard');
          return db.find(getSession());
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      const errors = findings.filter((f) => f.severity === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /getSession\(\) \[auth\.ts\]/);
    }
  );
});

test('does not flag a cross-file helper that never touches dynamic APIs', async () => {
  await withTempProject(
    {
      'lib/auth.ts': `
        import { cookies } from 'next/headers';
        export function getSession() { return cookies(); }
        export function unrelatedHelper() { return 42; }
      `,
      'products.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { unrelatedHelper } from './lib/auth';

        export async function getProducts() {
          'use cache';
          cacheLife('hours');
          cacheTag('products');
          return unrelatedHelper();
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
    }
  );
});

test('resolves an aliased named import ("import { x as y }")', async () => {
  await withTempProject(
    {
      'lib/auth.ts': `
        import { cookies } from 'next/headers';
        export function getSession() { return cookies(); }
      `,
      'page.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { getSession as getUserSession } from './lib/auth';

        export async function getData() {
          'use cache';
          cacheLife('hours');
          cacheTag('data');
          return getUserSession();
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      const errors = findings.filter((f) => f.severity === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /getUserSession\(\)/);
    }
  );
});

test('does not infinite-loop on a circular import between two helper files', async () => {
  await withTempProject(
    {
      'a.ts': `
        import { helperB } from './b';
        export function helperA() { return helperB(); }
      `,
      'b.ts': `
        import { helperA } from './a';
        export function helperB() { return helperA(); }
      `,
      'page.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { helperA } from './a';

        export async function getData() {
          'use cache';
          cacheLife('hours');
          cacheTag('data');
          return helperA();
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
    }
  );
});

test('does not follow a non-relative (package) import', async () => {
  await withTempProject(
    {
      'page.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { someLibraryFn } from 'some-npm-package';

        export async function getData() {
          'use cache';
          cacheLife('hours');
          cacheTag('data');
          return someLibraryFn();
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
    }
  );
});

test('resolves an import without an explicit extension against a .ts file', async () => {
  await withTempProject(
    {
      'lib/session.ts': `
        import { cookies } from 'next/headers';
        export function readSession() { return cookies(); }
      `,
      'page.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { readSession } from './lib/session';

        export async function getData() {
          'use cache';
          cacheLife('hours');
          cacheTag('data');
          return readSession();
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.severity === 'error').length, 1);
    }
  );
});

test('resolves a tsconfig path alias import (e.g. "@/*" -> "./*") - the standard Next.js convention', async () => {
  await withTempProject(
    {
      'tsconfig.json': `{
        "compilerOptions": {
          "paths": { "@/*": ["./*"] }
        }
      }`,
      'features/auth/getSession.ts': `
        import { cookies } from 'next/headers';
        export function getSession() { return cookies().get('session')?.value; }
      `,
      'features/product/Product.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { getSession } from '@/features/auth/getSession';

        export async function getProductForUser() {
          'use cache';
          cacheLife('minutes');
          cacheTag('product');
          return db.find(getSession());
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      const errors = findings.filter((f) => f.severity === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /getSession\(\) \[getSession\.ts\]/);
    }
  );
});

test('a project without tsconfig.json paths does not attempt alias resolution (no crash, no false positive)', async () => {
  await withTempProject(
    {
      'features/product/Product.tsx': `
        import { cacheLife, cacheTag } from 'next/cache';
        import { getSession } from '@/features/auth/getSession';

        export async function getProductForUser() {
          'use cache';
          cacheLife('minutes');
          cacheTag('product');
          return db.find(getSession());
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      // Can't resolve '@/...' without a tsconfig alias - should simply not
      // trace into it, not crash and not false-positive.
      assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
    }
  );
});
