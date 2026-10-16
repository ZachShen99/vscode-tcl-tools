'use strict';
// Conservative "undefined command" diagnostics (vscode-independent).
//
// A command-position word is reported only when everything below holds, so a warning means "this name is
// nowhere": it is not a built-in/interpreter command, the name never appears anywhere else in the workspace
// (a `proc`, `interp alias`, `coroutine`, `rename`, `sqlite3 db ...`, `Class create obj`, an import or even a
// comment/string mention all count as "appears"), and nothing reachable from the file can create commands
// dynamically or from a place we cannot see (wildcard `namespace import`, `namespace path`, `rename`, `load`,
// unresolved or computed `source`, a package that did not load, a changed `auto_path`, `proc $name`,
// a redefined `unknown`, Tk). Files with such a hazard are not checked at all.
const sourceGraph = require('./sourcegraph');

const TOKEN = /(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g;
const SAFE_PACKAGES = new Set(['Tcl']);
const facts = new WeakMap();

/** Per-file facts, cached on the (immutable) index entry: referenced names and static hazards. */
function factsOf(entry) {
  let f = facts.get(entry);
  if (f) return f;
  const text = entry.text || '';
  const commands = (entry.scan && entry.scan.commands) || [];
  const firstWords = [];
  const hazards = new Set();
  const raw = (w, i) => (i < w.length ? text.slice(w[i].start, w[i].end) : '');
  for (const command of commands) {
    const w = command.words;
    if (!w.length) continue;
    firstWords.push([w[0].start, w[0].end]);
    if (w[0].type !== 'bare') continue;
    const name = raw(w, 0).replace(/^::/, '');
    switch (name) {
      case 'rename': case 'load': case 'auto_load': case 'auto_mkindex': case 'auto_reset': case 'unknown':
        hazards.add(name); break;
      case 'namespace': {
        const sub = raw(w, 1);
        if (sub === 'path') hazards.add('namespace path');
        if (sub === 'import') {
          const args = w.slice(2).map((_, i) => raw(w, i + 2)).filter(a => a !== '-force');
          if (!args.length || args.some(a => /[*?\[]/.test(a))) hazards.add('namespace import with a pattern');
        }
        break;
      }
      case 'proc': {
        const given = raw(w, 1);
        if (/[$\[]/.test(given)) hazards.add('proc with a computed name');
        if (given === 'unknown' || given === '::unknown') hazards.add('unknown');
        break;
      }
      case 'set': case 'lappend': case 'append': case 'tcl::tm::path': case 'tcl::tm::roots':
        if (/^(::)?(auto_path|tcl::tm::(path|roots))$/.test(raw(w, 1)) || name.startsWith('tcl::tm::')) hazards.add('library path change');
        break;
      default: break;
    }
  }
  // Every identifier-like token outside the first word of a command, plus the tails of qualified names.
  const referenced = new Set();
  firstWords.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    while (cursor < firstWords.length && firstWords[cursor][1] <= m.index) cursor++;
    if (cursor < firstWords.length && firstWords[cursor][0] <= m.index && m.index < firstWords[cursor][1]) continue;
    const token = m[0].replace(/^::/, '');
    referenced.add(token);
    for (let i = token.indexOf('::'); i >= 0; i = token.indexOf('::', i + 2)) referenced.add(token.slice(i + 2));
  }
  f = { referenced, hazards };
  facts.set(entry, f);
  return f;
}

/** Union of the referenced names of all indexed files. */
function workspaceReferences(entries) {
  const all = new Set();
  for (const entry of entries) for (const token of factsOf(entry).referenced) all.add(token);
  return all;
}

const globToRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Build the checker for one document, or null when the file cannot be checked reliably.
 * @param {object} o {uri, entries, roots, runtime:{commands:Set, loaded:Set}, known:Set<string>, references:Set<string>,
 *                    extra:string[], procNames:string[], complete:boolean}
 * @returns {null | {check(name): null | {message: string}, reason?: string}}
 */
function build(o) {
  if (!o.complete) return { reason: 'the workspace index is incomplete (too many Tcl files); the check needs to see every file' };
  if (!o.runtime || !o.runtime.commands || o.runtime.commands.size < 30) return { reason: 'interpreter commands are not available yet (introspection has not finished or failed; try "Tcl: Refresh Introspection")' };
  const byUri = new Map(o.entries.map(e => [e.uri.toString(), e]));
  const closure = new Set(sourceGraph.dependencyDistances(o.uri, o.entries, o.roots || []).keys());
  closure.add(o.uri.toString());
  const loaded = o.runtime.loaded || new Set();
  const label = entry => String(entry.uri.path || entry.uri.fsPath || entry.uri).replace(/^.*[\\/]/, '');
  for (const key of closure) {
    const entry = byUri.get(key);
    if (!entry) continue;
    const hazards = factsOf(entry).hazards;
    if (hazards.size) return { reason: `${label(entry)} uses ${[...hazards].join(', ')}, which can create commands the extension cannot see` };
    for (const ref of entry.sources || []) {
      if (ref.dynamic || !sourceGraph.resolveReference(entry.uri, ref, o.entries, o.roots || []))
        return { reason: `${label(entry)} has a \`source\` that cannot be resolved statically` };
    }
    for (const pkg of (entry.scan && entry.scan.packages) || []) {
      if (pkg === 'Tk' || pkg === 'Ttk') return { reason: `${label(entry)} requires ${pkg}, whose commands are not covered` };
      if (!SAFE_PACKAGES.has(pkg) && !loaded.has(pkg)) return { reason: `package "${pkg}" (${label(entry)}) did not load in the interpreter` };
    }
  }
  const extra = (o.extra || []).map(globToRegExp);
  const isKnown = name => o.known.has(name) || o.runtime.commands.has(name) || extra.some(re => re.test(name));
  return {
    checker: {
      check(name) {
        if (!/^[A-Za-z_]\w*$/.test(name) || name === 'else' || name === 'elseif') return null;
        if (isKnown(name) || o.references.has(name)) return null;
        let best = null, bestDistance = 3;
        if (name.length >= 4) {
          for (const candidate of new Set([...o.known, ...o.runtime.commands, ...(o.procNames || [])])) {
            if (candidate.length < 3 || !/^[A-Za-z_]\w*$/.test(candidate)) continue;
            const d = distance(name, candidate);
            if (d < bestDistance || (d === bestDistance && best && candidate < best)) { best = candidate; bestDistance = d; }
          }
        }
        const hint = best && bestDistance <= 2 ? ` — did you mean "${best}"?` : '';
        return { message: `Unknown command "${name}": it is not a built-in or interpreter command and is not defined anywhere in the workspace${hint}` };
      }
    }
  };
}

/** Checker for one document, or null when the file cannot be checked reliably. */
function createChecker(o) { return build(o).checker || null; }
/** Why `createChecker` returned null (human readable). */
function explain(o) { return build(o).reason || null; }

module.exports = { factsOf, workspaceReferences, createChecker, explain, distance };
