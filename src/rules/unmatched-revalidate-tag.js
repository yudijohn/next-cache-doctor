'use strict';

/**
 * Rule: unmatched-revalidate-tag
 * Severity: warning
 *
 * Unlike the other rules, this one is project-wide rather than per-scope:
 * it cross-references every revalidateTag()/updateTag() call's first
 * argument against every cacheTag() call's arguments found anywhere in the
 * project. If a revalidation targets a tag string that no cacheTag() call
 * anywhere actually produced, that revalidation invalidates nothing - a
 * real, previously-undocumented Next.js 16 production bug class (typo'd or
 * drifted tag strings between the file that caches data and the file that
 * mutates it), and one TypeScript/Next.js does not catch: both calls are
 * ordinary string arguments, so a mismatch compiles and deploys cleanly.
 *
 * Matching is shape-based, not exact-string: `product-${id}` and
 * `product-${productId}` normalize to the same shape, so differently-named
 * variables in different files still match correctly. Non-literal tags
 * (identifiers, function calls, concatenation) can't be evaluated
 * statically and are skipped entirely - both as a potential cacheTag source
 * and as a revalidateTag/updateTag target - to avoid false positives.
 */
const id = 'unmatched-revalidate-tag';
const severity = 'warning';

/**
 * @param {{ revalidateCalls: Array<{file, line, shape, displayText, calleeName}>, cacheTagShapes: Set<string> }} ctx
 * @returns {Array<{file, line, rule, severity, message}>}
 */
function checkProject({ revalidateCalls, cacheTagShapes }) {
  const findings = [];

  for (const call of revalidateCalls) {
    if (cacheTagShapes.has(call.shape)) continue;

    findings.push({
      file: call.file,
      line: call.line,
      rule: id,
      severity,
      message: `${call.calleeName}(${call.displayText}, ...) doesn't match any cacheTag(...) found in this project. If the tag string doesn't exactly line up (typo, or it drifted from the cacheTag() call), this call invalidates nothing and the cache silently never refreshes.`,
    });
  }

  return findings;
}

module.exports = { id, severity, checkProject };
