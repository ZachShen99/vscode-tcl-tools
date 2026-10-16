'use strict';
// Scripts for "Run selection": each run gets its own private directory, old ones are swept.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'vscode-tcl-selection-';

/** Write text to a new private directory; returns {dir, file}. */
function createSelectionScript(text, root = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(root, PREFIX));     // mode 0700 on POSIX
  const file = path.join(dir, 'selection.tcl');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { dir, file };
}

/** Remove selection directories older than maxAgeMs (a run in progress is younger than that). */
function sweepSelectionScripts(maxAgeMs = 10 * 60 * 1000, root = os.tmpdir(), now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(root).filter(n => n.startsWith(PREFIX)); } catch (e) { return 0; }
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (now - fs.statSync(p).mtimeMs >= maxAgeMs) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
    } catch (e) { /* already gone */ }
  }
  return removed;
}

module.exports = { createSelectionScript, sweepSelectionScripts, PREFIX };
