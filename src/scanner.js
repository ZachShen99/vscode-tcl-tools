'use strict';
// Shared Tcl command scanner (vscode-independent).
//
// Splits a script into commands and words the way Tcl does and decides, per command, which braced words
// hold code (scanned recursively) and which hold plain data (skipped). Comments, backslash continuations,
// quoted strings and [command substitutions] are honoured. Everything that finds "commands in a document"
// (proc/namespace index, semantic highlighting of calls) builds on `scanCommands`, so a `proc` or a call that
// only appears inside a string, a comment or a data brace is never mistaken for a real one.
//
// Unknown commands default to "braces are code": that is how user-defined control structures
// (`with_lock {...}`) behave and it keeps the old highlighting. Known data commands (`set`, `list`,
// `puts`, `string`, ...) and widget/object calls (`.t insert end {...}`, `$obj m {...}`) are data.

const isWs = c => c === ' ' || c === '\t' || c === '\r';

function matchBrace(text, open, end) {
  let d = 0;
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

// Commands whose braced words are never scripts (except where bodyKinds says otherwise).
const DATA_COMMANDS = new Set(['set', 'variable', 'global', 'upvar', 'append', 'lappend', 'list', 'puts', 'return',
  'array', 'string', 'lindex', 'lrange', 'llength', 'lreplace', 'linsert', 'lset', 'lrepeat', 'lreverse', 'concat',
  'join', 'split', 'format', 'scan', 'regexp', 'regsub', 'file', 'info', 'error', 'subst', 'binary', 'encoding',
  'incr', 'unset', 'lsort', 'lsearch', 'lassign', 'dict', 'namespace', 'package', 'chan', 'fconfigure', 'open',
  'close', 'read', 'gets', 'clock', 'interp', 'fileevent_data']);

/** Kinds per word index: 'code' | 'expr' | 'data' (only braced words are looked at). */
function bodyKinds(words, text) {
  const n = words.length;
  const kinds = words.map(w => (w.type === 'brace' ? 'code' : null));
  const lit = i => (i < n && words[i].type === 'bare' ? text.slice(words[i].start, words[i].end) : null);
  const name = lit(0);
  const setAll = (from, k) => { for (let i = from; i < n; i++) if (kinds[i]) kinds[i] = k; };
  const first = text[words[0].start];
  if (name === null || first === '.' || first === '$') {
    // `$obj method {..}`, `.w configure -command {..}`: data unless it follows a -command/-script style option
    for (let i = 1; i < n; i++) {
      if (!kinds[i]) continue;
      const prev = lit(i - 1);
      kinds[i] = prev && /^-\w*(command|cmd|script)$/i.test(prev) ? 'code' : 'data';
    }
    return kinds;
  }
  const base = name.replace(/^::/, '');
  switch (base) {
    case 'proc': for (let i = 1; i < n - 1; i++) if (kinds[i]) kinds[i] = 'data'; break;
    case 'expr': setAll(1, 'expr'); break;
    case 'if': {
      if (kinds[1]) kinds[1] = 'expr';
      for (let i = 2; i < n - 1; i++) if (lit(i) === 'elseif' && kinds[i + 1]) kinds[i + 1] = 'expr';
      break;
    }
    case 'while': if (kinds[1]) kinds[1] = 'expr'; break;
    case 'for': if (kinds[2]) kinds[2] = 'expr'; break;
    case 'foreach': case 'lmap': for (let i = 1; i < n - 1; i++) if (kinds[i]) kinds[i] = 'data'; break;
    case 'try': {
      for (let i = 1; i < n; i++) {
        const w = lit(i);
        if ((w === 'on' || w === 'trap') && i + 2 < n) {
          if (kinds[i + 1] && w === 'trap') kinds[i + 1] = 'data';
          if (kinds[i + 2]) kinds[i + 2] = 'data';
        }
      }
      break;
    }
    case 'method': if (kinds[2] && n > 3) kinds[2] = 'data'; break;
    case 'constructor': if (kinds[1] && n > 2) kinds[1] = 'data'; break;
    case 'dict': {
      const sub = lit(1);
      if (sub === 'for' || sub === 'map' || sub === 'with' || sub === 'update') {
        for (let i = 2; i < n - 1; i++) if (kinds[i]) kinds[i] = 'data';
      } else setAll(1, 'data');
      break;
    }
    case 'namespace': {
      const sub = lit(1);
      if (sub === 'eval' || sub === 'inscope') { if (kinds[2]) kinds[2] = 'data'; } else setAll(1, 'data');
      break;
    }
    default:
      if (DATA_COMMANDS.has(base)) setAll(1, 'data');
  }
  return kinds;
}

/**
 * Parse text[i..end) as a script, appending commands to `out`. In bracket mode stops at the unmatched ']' and
 * returns its index. A list-mode parse (switch bodies) treats newlines as whitespace.
 */
function parseScript(text, i, end, out, mode) {
  const bracket = mode === 'bracket';
  const list = mode === 'list';
  while (i < end) {
    while (i < end && (isWs(text[i]) || text[i] === '\n' || text[i] === ';')) i++;
    if (i >= end) break;
    if (bracket && text[i] === ']') return i;
    if (!list && text[i] === '#') {
      while (i < end && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    const words = [];
    const cmdStart = i;
    while (i < end) {
      while (i < end) {
        if (isWs(text[i]) || (list && text[i] === '\n')) i++;
        else if (text[i] === '\\' && text[i + 1] === '\n') { i += 2; }
        else if (text[i] === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') { i += 3; }
        else break;
      }
      if (i >= end) break;
      const c = text[i];
      if (c === '\n' || c === ';') break;
      if (bracket && c === ']') break;
      const ws = i;
      if (c === '{') {
        const close = matchBrace(text, i, end);
        if (close < 0) { words.push({ start: ws, end, type: 'brace', open: true }); i = end; break; }
        i = close + 1;
        words.push({ start: ws, end: i, type: 'brace' });
        // characters glued to the closing brace belong to the same (malformed) word; skip them
        while (i < end && !isWs(text[i]) && text[i] !== '\n' && text[i] !== ';' && !(bracket && text[i] === ']')) i++;
      } else if (c === '"') {
        i++;
        while (i < end && text[i] !== '"') {
          if (text[i] === '\\') i += 2;
          else if (text[i] === '[') { i = parseScript(text, i + 1, end, out, 'bracket') + 1; }
          else i++;
        }
        i = Math.min(i + 1, end);
        words.push({ start: ws, end: i, type: 'quote' });
      } else {
        while (i < end) {
          const ch = text[i];
          if (isWs(ch) || ch === '\n' || ch === ';') break;
          if (bracket && ch === ']') break;
          if (ch === '\\') { if (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n')) break; i += 2; }
          else if (ch === '[') { i = parseScript(text, i + 1, end, out, 'bracket') + 1; }
          else i++;
        }
        words.push({ start: ws, end: Math.min(i, end), type: 'bare' });
      }
    }
    if (words.length && !list) {
      const cmd = { start: cmdStart, end: words[words.length - 1].end, words };
      out.push(cmd);
      recurseBodies(text, cmd, out);
    } else if (words.length) {
      out.listWords = (out.listWords || []).concat(words);
    }
  }
  return i;
}

function recurseBodies(text, cmd, out) {
  const { words } = cmd;
  const kinds = bodyKinds(words, text);
  const first = text.slice(words[0].start, words[0].end).replace(/^::/, '');
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.type === 'brace') {
      if (kinds[k] === 'code') {
        if (first === 'switch' && k === words.length - 1 && k >= 2) {
          switchBodies(text, w, out);
        } else {
          parseScript(text, w.start + 1, w.open ? w.end : w.end - 1, out, 'script');
        }
      } else if (kinds[k] === 'expr') {
        exprBrackets(text, w.start + 1, w.open ? w.end : w.end - 1, out);
      }
    } else if (w.type === 'quote' || w.type === 'bare') {
      // [..] inside were already scanned while reading the word
    }
  }
}

// `switch ... {pattern body pattern body}`: only the bodies are code.
function switchBodies(text, w, out) {
  const tmp = [];
  parseScript(text, w.start + 1, w.open ? w.end : w.end - 1, tmp, 'list');
  for (const c of tmp) out.push(c);          // substitutions found while reading the words
  (tmp.listWords || []).forEach((x, idx) => {
    if (idx % 2 === 1 && x.type === 'brace') parseScript(text, x.start + 1, x.open ? x.end : x.end - 1, out, 'script');
  });
}

// Brackets inside an expression brace are real command substitutions.
function exprBrackets(text, i, end, out) {
  while (i < end) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { i = parseScript(text, i + 1, end, out, 'bracket') + 1; continue; }
    i++;
  }
}

/** All commands in the script (including nested bodies / substitutions), sorted by position. */
function scanCommands(text) {
  const out = [];
  parseScript(text, 0, text.length, out, 'script');
  out.sort((a, b) => a.start - b.start);
  return out;
}

const wordText = (text, w) => {
  const s = text.slice(w.start, w.end);
  if (w.type === 'brace') return w.open ? s.slice(1) : s.slice(1, -1);
  if (w.type === 'quote') return s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined);
  return s;
};

module.exports = { scanCommands, wordText, matchBrace };
