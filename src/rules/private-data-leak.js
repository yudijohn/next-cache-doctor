'use strict';

/**
 * Rule: possible-private-data-leak
 * Severity: error
 *
 * A plain 'use cache' scope (i.e. NOT 'use cache: private') that reads
 * request-scoped data (cookies(), headers(), searchParams) - directly, or
 * through a helper function it calls, following the call stack. Next.js
 * itself enforces this with a hard error (`next-request-in-use-cache`) at
 * build or request time, precisely because the value can't vary the cache
 * per-request without risking one user's data landing in another user's
 * cached response. The catch: per Next.js's own docs, this can "pass next
 * build and fail under next start" - so it doesn't always surface until
 * production traffic hits the route. That's the real value of catching it
 * here: earlier, and without needing to exercise every code path to trigger
 * the runtime check.
 */
const id = 'possible-private-data-leak';
const severity = 'error';

const ENFORCEMENT_NOTE =
  "Next.js enforces this with a build/runtime error (next-request-in-use-cache) since the call stack reaches a request-scoped read inside a cache scope - but it can pass 'next build' and only surface once real traffic hits the route under 'next start'.";

function formatChain(viaChain) {
  return viaChain
    .map((step) => (step.file ? `${step.name}() [${basename(step.file)}]` : `${step.name}()`))
    .join(' → ');
}

function basename(absPath) {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function check({ kind, name, signals }) {
  if (kind === 'use cache: private') return null;

  const dynamicHit = signals.dynamicApiCalls[0];
  if (dynamicHit) {
    const message =
      dynamicHit.viaChain && dynamicHit.viaChain.length > 0
        ? `"${name}" is cached with plain 'use cache' but calls ${formatChain(dynamicHit.viaChain)}, which internally calls ${dynamicHit.name}(). ${ENFORCEMENT_NOTE} Move the ${dynamicHit.name}() call outside the cache scope and pass the value in as an argument, or use 'use cache: private'.`
        : `"${name}" is cached with plain 'use cache' but calls ${dynamicHit.name}() inside the cached scope. ${ENFORCEMENT_NOTE} Move the ${dynamicHit.name}() call outside the cache scope and pass the value in as an argument, or use 'use cache: private'.`;
    return {
      rule: id,
      severity,
      line: dynamicHit.line,
      scopeName: name,
      kind,
      message,
    };
  }

  const searchParamsHit = signals.searchParamsRefs[0];
  if (searchParamsHit) {
    return {
      rule: id,
      severity,
      line: searchParamsHit.line,
      scopeName: name,
      kind,
      message: `"${name}" is cached with plain 'use cache' but references searchParams inside the cached scope. ${ENFORCEMENT_NOTE} Read it outside the cache scope and pass the value in as an argument, or use 'use cache: private'.`,
    };
  }

  return null;
}

module.exports = { id, severity, check };
