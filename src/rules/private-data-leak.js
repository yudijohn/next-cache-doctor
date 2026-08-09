'use strict';

/**
 * Rule: possible-private-data-leak
 * Severity: error
 *
 * A plain 'use cache' scope (i.e. NOT 'use cache: private') that reads
 * request-scoped data (cookies(), headers(), searchParams) risks serving
 * one user's cached result to a different user, because the cache key
 * doesn't vary per-request.
 */
const id = 'possible-private-data-leak';
const severity = 'error';

function formatChain(viaChain) {
  return viaChain.map((n) => `${n}()`).join(' → ');
}

function check({ kind, name, signals }) {
  if (kind === 'use cache: private') return null;

  const dynamicHit = signals.dynamicApiCalls[0];
  if (dynamicHit) {
    const message =
      dynamicHit.viaChain && dynamicHit.viaChain.length > 0
        ? `"${name}" is cached with plain 'use cache' but calls ${formatChain(dynamicHit.viaChain)}, which internally calls ${dynamicHit.name}(). This can leak per-user data across users. Use 'use cache: private', or refactor to pass the value in as an argument instead.`
        : `"${name}" is cached with plain 'use cache' but calls ${dynamicHit.name}() inside the cached scope. This can leak per-user data across users. Use 'use cache: private', or refactor to pass the value in as an argument instead.`;
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
      message: `"${name}" is cached with plain 'use cache' but references searchParams inside the cached scope. This can serve one user's query results to another. Use 'use cache: private', or pass the needed value as an argument.`,
    };
  }

  return null;
}

module.exports = { id, severity, check };
