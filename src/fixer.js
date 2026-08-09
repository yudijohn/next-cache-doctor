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

    const sorted = [...fixes].sort((a, b) => b.insertPos - a.insertPos);
    for (const fix of sorted) {
      text = text.slice(0, fix.insertPos) + fix.insertText + text.slice(fix.insertPos);
      insertionsApplied += 1;
    }

    fs.writeFileSync(absPath, text, 'utf8');
    filesFixed.push(relFile);
  }

  return { filesFixed, insertionsApplied };
}

module.exports = { applyFixes };
