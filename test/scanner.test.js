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
    import { cacheLife, cacheTag } from 'next/cache';
    export async function getDashboard() {
      'use cache: private';
      cacheLife('minutes');
      cacheTag('dashboard');
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
    import { cacheLife, cacheTag } from 'next/cache';
    export async function outer() {
      'use cache';
      cacheLife('hours');
      cacheTag('outer');

      async function inner() {
        'use cache';
        // inner has no cacheLife/cacheTag - should be reported for INNER, not outer
        return fetch('/api/x');
      }
      return inner();
    }
  `;
  const findings = scanSource('nested.tsx', src);
  assert.equal(findings.length, 2); // inner: missing-cache-life + missing-cache-tag
  assert.ok(findings.every((f) => f.scopeName === 'inner'));
});

test('file-level "use cache" directive is detected', () => {
  const src = `
    'use cache';
    import { cacheLife, cacheTag } from 'next/cache';
    cacheLife('hours');
    cacheTag('data-module');
    export async function getData() {
      return fetch('/api/data');
    }
  `;
  const findings = scanSource('file-level.tsx', src);
  assert.equal(findings.length, 0);
});

test('flags missing cacheTag as info-level', () => {
  const src = `
    import { cacheLife } from 'next/cache';
    export async function getSettings() {
      'use cache';
      cacheLife('max');
      return fetchSettings();
    }
  `;
  const findings = scanSource('no-tag.tsx', src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'missing-cache-tag');
  assert.equal(findings[0].severity, 'info');
});

test('does not flag missing cacheTag when cacheTag is present', () => {
  const src = `
    import { cacheLife, cacheTag } from 'next/cache';
    export async function getSettings() {
      'use cache';
      cacheLife('max');
      cacheTag('settings');
      return fetchSettings();
    }
  `;
  const findings = scanSource('has-tag.tsx', src);
  assert.equal(findings.filter((f) => f.rule === 'missing-cache-tag').length, 0);
});

test('flags a leak reached through a same-file helper function (1 level)', () => {
  const src = `
    import { cookies } from 'next/headers';
    import { cacheLife, cacheTag } from 'next/cache';

    function getSession() {
      return cookies().get('session')?.value;
    }

    export async function getUserDashboard() {
      'use cache';
      cacheLife('minutes');
      cacheTag('dashboard');
      return db.find(getSession());
    }
  `;
  const findings = scanSource('helper-1.tsx', src);
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'possible-private-data-leak');
  assert.match(errors[0].message, /getSession\(\)/);
});

test('flags a leak reached through a 2-level helper chain', () => {
  const src = `
    import { cookies } from 'next/headers';
    import { cacheLife, cacheTag } from 'next/cache';

    function readCookieStore() { return cookies(); }
    function getSession() { return readCookieStore().get('session')?.value; }

    export async function getUserDashboard() {
      'use cache';
      cacheLife('minutes');
      cacheTag('dashboard');
      return db.find(getSession());
    }
  `;
  const findings = scanSource('helper-2.tsx', src);
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /getSession\(\).*readCookieStore\(\)/);
});

test('does not flag a helper function that never touches dynamic APIs', () => {
  const src = `
    import { cacheLife, cacheTag } from 'next/cache';
    function formatPrice(cents) { return (cents / 100).toFixed(2); }
    export async function getProducts() {
      'use cache';
      cacheLife('hours');
      cacheTag('products');
      return db.products.map((p) => formatPrice(p.cents));
    }
  `;
  const findings = scanSource('helper-clean.tsx', src);
  assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
});

test('does not infinite-loop on mutually recursive helper functions', () => {
  const src = `
    import { cacheLife, cacheTag } from 'next/cache';
    function a() { return b(); }
    function b() { return a(); }
    export async function getData() {
      'use cache';
      cacheLife('hours');
      cacheTag('data');
      return a();
    }
  `;
  const findings = scanSource('mutual-recursion.tsx', src);
  assert.equal(findings.filter((f) => f.severity === 'error').length, 0);
});

test('does not trace into a helper that has its own use cache directive', () => {
  const src = `
    import { cookies } from 'next/headers';
    import { cacheLife, cacheTag } from 'next/cache';

    async function getPrivateSession() {
      'use cache: private';
      cacheLife('minutes');
      cacheTag('session');
      return cookies().get('session')?.value;
    }

    export async function getUserDashboard() {
      'use cache';
      cacheLife('minutes');
      cacheTag('dashboard');
      return db.find(getPrivateSession());
    }
  `;
  const findings = scanSource('helper-own-scope.tsx', src);
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 0);
});
