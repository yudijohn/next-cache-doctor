'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runScan } = require('../src/index');

function withTempProject(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd-tags-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('flags a revalidateTag() whose string does not match any cacheTag() in the project', async () => {
  await withTempProject(
    {
      'data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProducts() {
          'use cache';
          cacheLife('hours');
          cacheTag('product-list');
          return db.query('SELECT * FROM products');
        }
      `,
      'actions.ts': `
        'use server';
        import { revalidateTag } from 'next/cache';
        export async function createProduct() {
          revalidateTag('products', 'max');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      const tagFindings = findings.filter((f) => f.rule === 'unmatched-revalidate-tag');
      assert.equal(tagFindings.length, 1);
      assert.equal(tagFindings[0].severity, 'warning');
      assert.equal(tagFindings[0].file, 'actions.ts');
    }
  );
});

test('does not flag a revalidateTag() whose string exactly matches a cacheTag()', async () => {
  await withTempProject(
    {
      'data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProducts() {
          'use cache';
          cacheLife('hours');
          cacheTag('products');
          return db.query('SELECT * FROM products');
        }
      `,
      'actions.ts': `
        'use server';
        import { revalidateTag } from 'next/cache';
        export async function createProduct() {
          revalidateTag('products', 'max');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.rule === 'unmatched-revalidate-tag').length, 0);
    }
  );
});

test('matches template-literal tags by shape, even with differently-named variables', async () => {
  await withTempProject(
    {
      'data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProduct(id: string) {
          'use cache';
          cacheLife('hours');
          cacheTag(\`product-\${id}\`);
          return db.query('SELECT * FROM products WHERE id = ?', [id]);
        }
      `,
      'actions.ts': `
        'use server';
        import { revalidateTag } from 'next/cache';
        export async function updateProduct(productId: string) {
          revalidateTag(\`product-\${productId}\`, 'max');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.rule === 'unmatched-revalidate-tag').length, 0);
    }
  );
});

test('flags a template-literal revalidateTag whose shape does not match any cacheTag shape', async () => {
  await withTempProject(
    {
      'data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProduct(id: string) {
          'use cache';
          cacheLife('hours');
          cacheTag(\`product-\${id}\`);
          return db.query('SELECT * FROM products WHERE id = ?', [id]);
        }
      `,
      'actions.ts': `
        'use server';
        import { revalidateTag } from 'next/cache';
        export async function updateProduct(productId: string) {
          revalidateTag(\`item-\${productId}\`, 'max');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.rule === 'unmatched-revalidate-tag').length, 1);
    }
  );
});

test('does not flag (and does not crash on) a fully dynamic tag argument', async () => {
  await withTempProject(
    {
      'actions.ts': `
        'use server';
        import { revalidateTag } from 'next/cache';
        export async function invalidate(tagName: string) {
          revalidateTag(tagName, 'max');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.rule === 'unmatched-revalidate-tag').length, 0);
    }
  );
});

test('also checks updateTag() calls against known cacheTag() shapes', async () => {
  await withTempProject(
    {
      'data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProducts() {
          'use cache';
          cacheLife('hours');
          cacheTag('products');
          return db.query('SELECT * FROM products');
        }
      `,
      'actions.ts': `
        'use server';
        import { updateTag } from 'next/cache';
        export async function createProduct() {
          updateTag('product-catalog');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      const tagFindings = findings.filter((f) => f.rule === 'unmatched-revalidate-tag');
      assert.equal(tagFindings.length, 1);
      assert.match(tagFindings[0].message, /updateTag/);
    }
  );
});

test('finds a cacheTag() defined in one file matching a revalidateTag() in an unrelated file with no cache scope of its own', async () => {
  await withTempProject(
    {
      'features/products/data.ts': `
        import { cacheTag, cacheLife } from 'next/cache';
        export async function getProducts() {
          'use cache';
          cacheLife('hours');
          cacheTag('products');
          return db.query('SELECT * FROM products');
        }
      `,
      'app/api/webhook/route.ts': `
        import { revalidateTag } from 'next/cache';
        export async function POST() {
          revalidateTag('products', 'max');
          return new Response('ok');
        }
      `,
    },
    async (dir) => {
      const { findings } = await runScan(dir);
      assert.equal(findings.filter((f) => f.rule === 'unmatched-revalidate-tag').length, 0);
    }
  );
});
