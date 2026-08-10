'use strict';

/**
 * Rule: missing-cache-tag
 * Severity: info
 *
 * A 'use cache' scope with no cacheTag(...) can only be invalidated by
 * waiting for its cacheLife to expire - there's no way to invalidate it
 * on-demand via revalidateTag() when the underlying data changes. This is
 * often fine (e.g. static content), so it's informational, not an error.
 */
const id = 'missing-cache-tag';
const severity = 'info';

function check({ kind, name, line, signals }) {
  if (signals.hasCacheTag) return null;

  return {
    rule: id,
    severity,
    line,
    scopeName: name,
    kind,
    fixable: true,
    message: `'${kind}' scope "${name}" has no cacheTag(...). Without a tag you can only invalidate this cache by waiting for cacheLife to expire, not on-demand via revalidateTag(). Consider adding cacheTag() if this data can change from elsewhere in the app.`,
  };
}

module.exports = { id, severity, check };
