'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanSource } = require('../src/scanner');

test('clean code with cacheLife produces no findings', () => {
  const src = `
    import { cacheLife, cacheTag } from 'next/cache';
    export async function getPost(slug) {
      'use cache';
      cacheTag('post-' + slug);
      cacheLife('days');
      return fetchPost(slug);
    }
  `;
  const findings = scanSource('good.tsx', src);
  assert.equal(findings.length, 0);
});

test('flags missing cacheLife as a warning', () => {
  const src = `
    import { cacheTag } from 'next/cache';
    export async function getProducts() {
      'use cache';
      cacheTag('products');
      return fetch('/api/products');
    }
  `;
  const findings = scanSource('missing.tsx', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'missing-cache-life');
  assert.equal(findings[0].severity, 'warning');
});

test('flags cookies() inside plain use cache as an error', () => {
  const src = `
    import { cookies } from 'next/headers';
    import { cacheLife } from 'next/cache';
    export async function getDashboard() {
      'use cache';
      cacheLife('minutes');
      const c = cookies();
      return db.find(c.get('session'));
    }
  `;
  const findings = scanSource('leak.tsx', src);
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'possible-private-data-leak');
});

test('does not flag cookies() inside use cache: private', () => {
  const src = `
    import { cookies } from 'next/headers';
    import { cacheLife } from 'next/cache';
    export async function getDashboard() {
      'use cache: private';
      cacheLife('minutes');
      const c = cookies();
      return db.find(c.get('session'));
    }
  `;
  const findings = scanSource('private.tsx', src);
  assert.equal(findings.length, 0);
});

test('flags searchParams usage inside plain use cache', () => {
  const src = `
    import { cacheLife } from 'next/cache';
    export async function search({ searchParams }) {
      'use cache';
      cacheLife('minutes');
      return db.search(searchParams.q);
    }
  `;
  const findings = scanSource('search.tsx', src);
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'possible-private-data-leak');
});

test('does not descend into a nested independent cache scope', () => {
  const src = `
    import { cacheLife } from 'next/cache';
    export async function outer() {
      'use cache';
      cacheLife('hours');

      async function inner() {
        'use cache';
        // inner has no cacheLife - should be reported for INNER, not outer
        return fetch('/api/x');
      }
      return inner();
    }
  `;
  const findings = scanSource('nested.tsx', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scopeName, 'inner');
});

test('file-level "use cache" directive is detected', () => {
  const src = `
    'use cache';
    import { cacheLife } from 'next/cache';
    cacheLife('hours');
    export async function getData() {
      return fetch('/api/data');
    }
  `;
  const findings = scanSource('file-level.tsx', src);
  assert.equal(findings.length, 0);
});
