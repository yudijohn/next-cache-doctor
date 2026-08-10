'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Applies all `fix` entries attached to findings, grouped by file.
 * Fixes within a file are applied from the highest insertPos to the
 * lowest, so earlier insertions don't shift the offsets of later ones.
 *
 * @returns {{ filesFixed: string[], insertionsApplied: number }}
 */
function applyFixes(targetDir, findings) {
  const byFile = new Map();
  for (const finding of findings) {
    if (!finding.fix) continue;
    const list = byFile.get(finding.file) || [];
    list.push(finding.fix);
    byFile.set(finding.file, list);
  }

  const filesFixed = [];
  let insertionsApplied = 0;

  for (const [relFile, fixes] of byFile) {
    const absPath = path.resolve(targetDir, relFile);
    let text = fs.readFileSync(absPath, 'utf8');

    // Multiple findings (e.g. missing-cache-life AND missing-cache-tag on
    // the same scope) can land on the exact same insertPos. Applying two
    // separate slice-and-splice operations at an identical offset would
    // silently reverse their order (the second insertion lands *inside*
    // the first one's suffix). So we merge same-position fixes into a
    // single combined insertText first, preserving discovery order, then
    // apply one splice per unique position.
    const byPos = new Map();
    for (const fix of fixes) {
      const existing = byPos.get(fix.insertPos);
      if (existing) {
        existing.insertText += fix.insertText;
      } else {
        byPos.set(fix.insertPos, { insertPos: fix.insertPos, insertText: fix.insertText });
      }
      insertionsApplied += 1;
    }

    const merged = [...byPos.values()].sort((a, b) => b.insertPos - a.insertPos);
    for (const fix of merged) {
      text = text.slice(0, fix.insertPos) + fix.insertText + text.slice(fix.insertPos);
    }

    fs.writeFileSync(absPath, text, 'utf8');
    filesFixed.push(relFile);
  }

  return { filesFixed, insertionsApplied };
}

module.exports = { applyFixes };
