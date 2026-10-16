'use strict';

// Conservative, vscode-independent static symbol resolution. Tcl can create and
// rename commands dynamically, so this module only resolves literal proc calls
// and ordinary variable substitutions/declarations that have a stable lexical
// scope. That makes references and rename useful without guessing across files.
const scanner = require('./scanner');

const NAME_RE = /^(?:::)?[A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*$/;
const SIMPLE_RE = /^[A-Za-z_]\w*$/;
const VAR_RE = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;

function namespaceAt(scan, offset) {
  let best = null;
  for (const n of scan.namespaces || []) {
    if (n.start < offset && offset < n.end && (!best || n.start > best.start)) best = n;
  }
  if (!best) return '';
  const parents = (scan.namespaces || []).filter(n => n !== best && n.start < best.start && best.end <= n.end)
    .sort((a, b) => a.start - b.start);
  let ns = '';
  for (const n of [...parents, best]) ns = n.name.startsWith('::') ? n.name : `${ns}::${n.name}`;
  return ns;
}

function procAt(scan, offset) {
  let best = null;
  for (const p of scan.procs || []) {
    if (p.bodyStart >= 0 && p.bodyStart <= offset && offset <= p.bodyEnd && (!best || p.bodyStart > best.bodyStart)) best = p;
  }
  return best;
}

function qualify(name, ns) {
  if (name.startsWith('::')) return name;
  return `${ns || ''}::${name}`;
}

function procCandidates(name, scan, offset) {
  if (!NAME_RE.test(name)) return [];
  if (name.startsWith('::')) return [name];
  const ns = namespaceAt(scan, offset);
  if (name.includes('::')) return ns ? [`${ns}::${name}`, `::${name}`] : [`::${name}`];
  return ns ? [`${ns}::${name}`, `::${name}`] : [`::${name}`];
}

function resolveProc(name, scan, offset, definitions) {
  for (const fq of procCandidates(name, scan, offset)) {
    const hits = definitions.filter(d => d.fq === fq);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // duplicate definitions are unsafe to rename
  }
  return null;
}

function procCalls(text, scan) {
  const out = [];
  for (const c of scanner.scanCommands(text)) {
    const w = c.words[0];
    if (!w || w.type !== 'bare') continue;
    const name = text.slice(w.start, w.end);
    if (!NAME_RE.test(name) || name === 'proc') continue;
    out.push({ kind: 'proc', name, start: w.start, end: w.end, declaration: false });
  }
  return out;
}

function listElements(text, word) {
  if (!word || word.type !== 'brace') return [];
  const start = word.start + 1, end = word.open ? word.end : word.end - 1;
  const out = [];
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end) break;
    let s = i;
    if (text[i] === '{') {
      let depth = 1; i++;
      while (i < end && depth) { if (text[i] === '\\') i += 2; else if (text[i] === '{') { depth++; i++; } else if (text[i] === '}') { depth--; i++; } else i++; }
      const innerStart = s + 1, innerEnd = Math.max(innerStart, i - 1);
      const nested = { start: innerStart, end: innerEnd, value: text.slice(innerStart, innerEnd) };
      out.push(nested);
    } else {
      while (i < end && !/\s/.test(text[i])) i++;
      out.push({ start: s, end: i, value: text.slice(s, i) });
    }
  }
  return out;
}

function variableScope(scan, offset) {
  const p = procAt(scan, offset);
  return p ? `proc:${p.startIdx}` : `ns:${namespaceAt(scan, offset)}`;
}

function variableKey(name, scan, offset, links) {
  if (name.startsWith('::') || name.includes('::')) return `namespace:${qualify(name, namespaceAt(scan, offset))}`;
  const p = procAt(scan, offset);
  if (p) {
    const link = links.get(`${p.startIdx}:${name}`);
    if (link && offset >= link.start) return link.key;
    return `local:${p.startIdx}:${name}`;
  }
  return `namespace:${qualify(name, namespaceAt(scan, offset))}`;
}

function variableSymbols(text, scan) {
  const declarations = [];
  const uses = [];
  const links = new Map();
  const commands = scanner.scanCommands(text);
  const literal = w => w && w.type === 'bare' ? text.slice(w.start, w.end) : '';
  const addDecl = (name, start, end, offset = start, forcedKey) => {
    const array = /^((?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\(/.exec(name);
    if (array) { name = array[1]; end = start + name.length; }
    if (!VAR_RE.test(name)) return;
    declarations.push({ kind: 'variable', name, start, end, declaration: true, offset, forcedKey });
  };
  const addBareUse = (name, start, end) => {
    const array = /^((?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\(/.exec(name);
    if (array) { name = array[1]; end = start + name.length; }
    if (VAR_RE.test(name)) uses.push({ kind: 'variable', name, start, end, declaration: false });
  };

  // Proc arguments are local declarations. Nested/default argument specs use
  // the first list element as the argument name.
  for (const p of scan.procs || []) {
    const cmd = commands.find(c => c.start === p.startIdx);
    const argWord = cmd && cmd.words[2];
    for (const spec of listElements(text, argWord)) {
      let name = spec.value, start = spec.start, end = spec.end;
      if (/\s/.test(name)) {
        const m = /^\s*([^\s{}]+)/.exec(name);
        if (!m) continue;
        name = m[1]; start += m[0].indexOf(name); end = start + name.length;
      }
      addDecl(name, start, end, p.bodyStart, `local:${p.startIdx}:${name}`);
    }
  }

  for (const c of commands) {
    const w = c.words;
    const cmd = literal(w[0]);
    const p = procAt(scan, c.start);
    const one = i => { const name = literal(w[i]); if (name) addDecl(name, w[i].start, w[i].end); };
    if (cmd === 'set' || cmd === 'incr' || cmd === 'append' || cmd === 'lappend') one(1);
    else if (cmd === 'unset') {
      for (let i = 1; i < w.length; i++) { const name = literal(w[i]); if (name && !name.startsWith('-')) addBareUse(name, w[i].start, w[i].end); }
    }
    else if (cmd === 'variable') {
      for (let i = 1; i < w.length; i += 2) {
        const name = literal(w[i]); if (!name) continue;
        const key = `namespace:${qualify(name, namespaceAt(scan, c.start))}`;
        if (p) links.set(`${p.startIdx}:${name}`, { key, start: c.start });
        addDecl(name, w[i].start, w[i].end, c.start, key);
      }
    } else if (cmd === 'global' && p) {
      for (let i = 1; i < w.length; i++) {
        const name = literal(w[i]); if (!name) continue;
        const key = `namespace:${qualify(name, '')}`;
        links.set(`${p.startIdx}:${name}`, { key, start: c.start });
        addDecl(name, w[i].start, w[i].end, c.start, key);
      }
    } else if (cmd === 'foreach' || cmd === 'lmap') {
      for (let i = 1; i + 1 < w.length; i += 2) {
        if (w[i].type === 'brace') for (const e of listElements(text, w[i])) addDecl(e.value, e.start, e.end);
        else one(i);
      }
    } else if (cmd === 'lassign') {
      for (let i = 2; i < w.length; i++) one(i);
    } else if (cmd === 'catch') {
      one(2); one(3);
    } else if (cmd === 'gets') {
      one(2);
    } else if (cmd === 'scan') {
      for (let i = 3; i < w.length; i++) one(i);
    } else if (cmd === 'binary' && literal(w[1]) === 'scan') {
      for (let i = 4; i < w.length; i++) one(i);
    } else if (cmd === 'array' && (literal(w[1]) === 'set' || literal(w[1]) === 'unset')) {
      one(2);
    } else if (cmd === 'dict' && ['set', 'unset', 'append', 'lappend', 'incr'].includes(literal(w[1]))) {
      one(2);
    } else if (cmd === 'dict' && (literal(w[1]) === 'for' || literal(w[1]) === 'map')) {
      for (const e of listElements(text, w[2])) addDecl(e.value, e.start, e.end);
    } else if (cmd === 'dict' && literal(w[1]) === 'update') {
      for (let i = 3; i + 1 < w.length; i += 2) one(i);
    } else if (cmd === 'upvar') {
      let i = 1;
      if (literal(w[i]) && (/^#?\d+$/.test(literal(w[i])) || literal(w[i]) === '#0')) i++;
      for (; i + 1 < w.length; i += 2) one(i + 1);
    }

    // Tcl performs substitutions in bare and quoted words. Braced expressions
    // are evaluated by expr/if/while/for and therefore also contain references.
    for (let wi = 0; wi < w.length; wi++) {
      const word = w[wi];
      const exprBrace = word.type === 'brace' && ((cmd === 'expr') || (cmd === 'while' && wi === 1) ||
        (cmd === 'if' && (wi === 1 || literal(w[wi - 1]) === 'elseif')) || (cmd === 'for' && wi === 2));
      if (word.type === 'brace' && !exprBrace) continue;
      const sourceStart = word.start + (word.type === 'quote' || word.type === 'brace' ? 1 : 0);
      const sourceEnd = word.end - (word.type === 'quote' || (word.type === 'brace' && !word.open) ? 1 : 0);
      const re = /\$(?:\{((?:::)?[A-Za-z_]\w*(?:::\w+)*)\}|((?:::)?[A-Za-z_]\w*(?:::\w+)*))/g;
      re.lastIndex = sourceStart;
      let m;
      while ((m = re.exec(text)) && m.index < sourceEnd) {
        const name = m[1] || m[2];
        const start = m.index + (m[1] ? 2 : 1);
        uses.push({ kind: 'variable', name, start, end: start + name.length, declaration: false });
      }
    }
  }

  const all = [...declarations, ...uses];
  for (const s of all) s.key = s.forcedKey || variableKey(s.name, scan, s.offset === undefined ? s.start : s.offset, links);
  return all.sort((a, b) => a.start - b.start || Number(b.declaration) - Number(a.declaration));
}

function symbolAt(text, scan, offset) {
  for (const p of scan.procs || []) if (p.nameStart <= offset && offset <= p.nameEnd) return { kind: 'proc', definition: p, start: p.nameStart, end: p.nameEnd, name: p.written };
  const variable = variableSymbols(text, scan).find(s => s.start <= offset && offset <= s.end);
  if (variable) return variable;
  return procCalls(text, scan).find(s => s.start <= offset && offset <= s.end) || null;
}

function visibleVariables(text, scan, offset) {
  const here = variableScope(scan, offset);
  const seen = new Set();
  for (const s of variableSymbols(text, scan)) {
    if (s.start > offset || variableScope(scan, s.offset === undefined ? s.start : s.offset) !== here) continue;
    seen.add(s.name);
  }
  return [...seen];
}

function fuzzyScore(value, term) {
  const text = value.toLowerCase();
  term = term.toLowerCase();
  if (!term) return 0;
  if (text === term) return 0;
  if (text.startsWith(term)) return 10 + text.length - term.length;
  const inside = text.indexOf(term);
  if (inside >= 0) return 100 + inside + text.length - term.length;
  let at = 0, gaps = 0, previous = -1;
  for (const char of term) {
    const found = text.indexOf(char, at);
    if (found < 0) return Infinity;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    at = found + 1;
  }
  return 300 + gaps + text.length - term.length;
}

/**
 * Workspace procedure and namespace definitions, independent of VS Code.
 * Dynamic names are omitted because their runtime spelling is not knowable.
 */
function workspaceSymbols(entries, query, limit = 1000) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const out = [];
  const literal = name => name && !/[$\[\\]/.test(name);
  const add = symbol => {
    const names = [symbol.name, symbol.fq.replace(/^::/, '')];
    let score = 0;
    for (const term of terms) {
      const part = Math.min(...names.map(name => fuzzyScore(name, term)));
      if (!Number.isFinite(part)) return;
      score += part;
    }
    out.push({ ...symbol, score });
  };
  for (const entry of entries) {
    for (const namespace of entry.scan.namespaces || []) {
      const parent = namespaceAt(entry.scan, namespace.startIdx);
      const fq = namespace.name.startsWith('::') ? namespace.name : `${parent || ''}::${namespace.name}`;
      if (!literal(fq)) continue;
      add({ kind: 'namespace', name: namespace.name.replace(/^.*::/, ''), fq, uri: entry.uri,
        start: namespace.nameStart, end: namespace.nameEnd });
    }
    for (const proc of entry.scan.procs || []) {
      if (!literal(proc.fq)) continue;
      add({ kind: 'proc', name: proc.name, fq: proc.fq, uri: entry.uri,
        start: proc.nameStart, end: proc.nameEnd, signature: proc.args.map(arg => arg.default === undefined ? arg.name : `?${arg.name}?`).join(' ') });
    }
  }
  return out.sort((a, b) => a.score - b.score || a.fq.localeCompare(b.fq) || a.uri.toString().localeCompare(b.uri.toString())).slice(0, limit);
}

module.exports = { namespaceAt, procAt, procCandidates, resolveProc, procCalls, variableSymbols, symbolAt, visibleVariables, workspaceSymbols, SIMPLE_RE };
