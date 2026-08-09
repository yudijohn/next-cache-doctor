'use strict';

/**
 * Rule: missing-cache-life
 * Severity: warning
 *
 * A 'use cache' scope should always set an explicit cacheLife(...) so the
 * duration is clear at the call site instead of silently falling back to
 * the default profile.
 */
const id = 'missing-cache-life';
const severity = 'warning';

function check({ kind, name, line, signals }) {
  if (signals.hasCacheLife) return null;

  return {
    rule: id,
    severity,
    line,
    scopeName: name,
    kind,
    fixable: true,
    message: `'${kind}' scope "${name}" has no explicit cacheLife(...). The default profile will apply implicitly - add cacheLife() to make the duration explicit at the call site.`,
  };
}

module.exports = { id, severity, check };
