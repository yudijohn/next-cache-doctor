'use strict';

/**
 * All active rules. To add a new rule:
 *   1. Create src/rules/your-rule.js exporting { id, severity, check(ctx) }
 *   2. Import and add it to this array.
 *
 * `check(ctx)` receives { kind, name, line, signals } for one cache scope
 * and returns either `null` (no issue) or a finding object.
 */
const missingCacheLife = require('./missing-cache-life');
const privateDataLeak = require('./private-data-leak');
const missingCacheTag = require('./missing-cache-tag');

const rules = [missingCacheLife, privateDataLeak, missingCacheTag];

module.exports = { rules };
