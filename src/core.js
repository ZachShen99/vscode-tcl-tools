'use strict';
// vscode-independent logic: parsing, scanning, context analysis, signature lookup.
const builtins = require('./builtins.json');
const tk = require('./tk.json');
const scanner = require('./scanner');
// Tk commands are merged into the builtin tables (hover/signature work everywhere); completion of the
// command names themselves is limited to files that load Tk (see tkNames / usesTk).
Object.assign(builtins.commands, tk.commands);
Object.assign(builtins.ensembles, tk.ensembles);
const tkNames = new Set([...Object.keys(tk.commands), ...Object.keys(tk.ensembles)]);
const staticEnsembles = JSON.parse(JSON.stringify(tk.ensembles));
let tkRuntime = null; // what the installed Tk reported (see introspect_tk.tcl); layered over the static tables

// ---------- Tcl list / word helpers ----------

/** Parse a Tcl list string into its elements (one level; braces/quotes stripped). */
function parseList(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '{') {
      let d = 1, j = i + 1;
      while (j < n && d > 0) {
        if (s[j] === '\\') j++;
        else if (s[j] === '{') d++;
        else if (s[j] === '}') d--;
        j++;
      }
      out.push(s.slice(i + 1, d === 0 ? j - 1 : j));
      i = j;
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') { if (s[j] === '\\') j++; j++; }
      out.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !/\s/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Index of the brace matching the '{' at `open`, or -1. Mirrors Tcl: comments are not special. */
function matchBrace(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

/** Read one word (braced, quoted or bare) starting at i. Returns {value, end} or null. */
function readWord(text, i) {
  if (i >= text.length) return null;
  if (text[i] === '{') {
    const close = matchBrace(text, i);
    if (close < 0) return null;
    return { value: text.slice(i + 1, close), end: close + 1 };
  }
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
    return { value: text.slice(i + 1, j), end: j + 1 };
  }
  let j = i;
  while (j < text.length && !/\s/.test(text[j])) j++;
  return { value: text.slice(i, j), end: j };
}

/** proc argument list -> [{name, default?}] */
function parseArgs(argText) {
  return parseList(argText).map(spec => {
    const p = parseList(spec);
    return p.length > 1 ? { name: p[0], default: p[1] } : { name: p[0] || spec };
  });
}

// ---------- document scanning ----------

function scanDocument(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = idx => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const lines = text.split('\n');

  // Commands come from the shared scanner, so a `proc` / `namespace eval` inside a string, a comment or a data
  // brace (`set template {proc x {} {}}`) is not indexed.
  const cmds = scanner.scanCommands(text);
  const wtext = w => scanner.wordText(text, w);
  const namespaces = [];
  for (const c of cmds) {
    const w = c.words;
    if (w.length < 4 || w[0].type !== 'bare' || text.slice(w[0].start, w[0].end) !== 'namespace') continue;
    if (text.slice(w[1].start, w[1].end) !== 'eval' || w[3].type !== 'brace') continue;
    const open = w[3].start;
    const close = w[3].open ? -1 : w[3].end - 1;
    namespaces.push({
      name: wtext(w[2]), start: open, end: close < 0 ? text.length : close, startIdx: c.start,
      nameStart: w[2].start, nameEnd: w[2].end,
      line: lineOf(c.start), endLine: lineOf(close < 0 ? text.length - 1 : close)
    });
  }

  const nsOf = idx => {
    let ns = '';
    for (const r of namespaces.filter(r => r.start < idx && idx < r.end).sort((a, b) => a.start - b.start)) {
      ns = r.name.startsWith('::') ? r.name : (ns ? `${ns}::${r.name}` : `::${r.name}`);
    }
    return ns;
  };

  const procs = [];
  for (const c of cmds) {
    const w = c.words;
    if (w.length < 3 || w[0].type !== 'bare' || text.slice(w[0].start, w[0].end) !== 'proc') continue;
    const at = c.start;
    const name = wtext(w[1]);
    const argsWord = w[2];
    const body = w[3] && w[3].type === 'brace' && !w[3].open ? w[3] : null;
    const close = body ? body.end - 1 : -1;
    const line = lineOf(at);
    const ns = nsOf(at);
    const fq = name.startsWith('::') ? name : `${ns || ''}::${name}`;
    const docLines = [];
    for (let l = line - 1; l >= 0 && /^\s*#/.test(lines[l]); l--) {
      docLines.unshift(lines[l].replace(/^\s*#+\s?/, ''));
    }
    procs.push({
      name: fq.split('::').pop(),
      fq,
      ns: fq.slice(0, fq.lastIndexOf('::')),
      args: parseArgs(wtext(argsWord)),
      line,
      written: name,
      nameStart: w[1].start,
      nameEnd: w[1].end,
      argsStart: argsWord.start,
      argsEnd: argsWord.end,
      bodyStart: body ? body.start + 1 : -1,
      bodyEnd: body ? body.end - 1 : -1,
      startIdx: at,
      endIdx: close >= 0 ? close : argsWord.end,
      endLine: close >= 0 ? lineOf(close) : line,
      doc: docLines.join('\n')
    });
  }

  const vars = new Set();
  const addVar = v => { if (v && /^[A-Za-z_][\w:]*$/.test(v)) vars.add(v); };
  const packages = [];
  // Variables and packages come from real commands only (not from text inside strings, comments or data).
  for (const c of cmds) {
    const w = c.words;
    if (w[0].type !== 'bare') continue;
    const name = text.slice(w[0].start, w[0].end);
    const arg = i => (i < w.length ? wtext(w[i]) : '');
    const lit = i => (i < w.length && w[i].type === 'bare' ? wtext(w[i]) : '');
    switch (name) {
      case 'set': case 'variable': case 'incr': case 'append': case 'lappend': addVar(lit(1)); break;
      case 'global': for (let i = 1; i < w.length; i++) addVar(lit(i)); break;
      case 'foreach': case 'lmap': {
        for (let i = 1; i + 1 < w.length; i += 2) {
          (w[i].type === 'brace' ? parseList(arg(i)) : [lit(i)]).forEach(addVar);
        }
        break;
      }
      case 'dict':
        if ((lit(1) === 'for' || lit(1) === 'map') && w[2] && w[2].type === 'brace') parseList(arg(2)).forEach(addVar);
        break;
      case 'lassign': for (let i = 2; i < w.length; i++) addVar(lit(i)); break;
      case 'package': {
        if (lit(1) !== 'require') break;
        let i = 2;
        if (lit(i) === '-exact') i++;
        const pk = lit(i);
        if (pk && !packages.includes(pk)) packages.push(pk);
        break;
      }
      default: break;
    }
  }
  for (const p of procs) p.args.forEach(a => addVar(a.name));

  return { procs, namespaces, vars: [...vars], packages, commands: cmds };
}

// ---------- context analysis ----------

const ensembleNames = Object.keys(builtins.ensembles);
const ensembleRe = new RegExp(`(?:^|[\\[;])\\s*(${ensembleNames.join('|')})\\s+(\\w*)$`);

function analyzeLinePrefix(prefix) {
  let m;
  if ((m = /\$\{?([\w:]*)$/.exec(prefix))) return { kind: 'variable', word: m[1] };
  if ((m = /(?:^|[\[;])\s*package\s+(?:require|present|provide)\s+(?:-exact\s+)?([\w:.]*)$/.exec(prefix))) {
    return { kind: 'package', word: m[1] };
  }
  if ((m = ensembleRe.exec(prefix))) return { kind: 'subcommand', cmd: m[1], word: m[2] };
  if ((m = /(?:^|[\[;])\s*([\w:]*)$/.exec(prefix))) return { kind: 'command', word: m[1] };
  return { kind: 'none' };
}

/** Split a command segment into words. `open` is true when the last word is still being typed. */
function splitWords(seg) {
  const words = [];
  const n = seg.length;
  let i = 0, unclosed = false;
  while (i < n) {
    while (i < n && /\s/.test(seg[i])) i++;
    if (i >= n) break;
    const start = i;
    unclosed = false;
    if (seg[i] === '{') {
      let d = 0;
      while (i < n) {
        const c = seg[i];
        if (c === '\\') i++;
        else if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) { i++; break; } }
        i++;
      }
      if (d > 0) unclosed = true;
    } else if (seg[i] === '"') {
      i++;
      while (i < n && seg[i] !== '"') { if (seg[i] === '\\') i++; i++; }
      if (i >= n) unclosed = true; else i++;
    } else {
      while (i < n && !/\s/.test(seg[i])) {
        if (seg[i] === '[') {
          let d = 0;
          while (i < n) {
            if (seg[i] === '[') d++;
            else if (seg[i] === ']') { d--; if (d === 0) { i++; break; } }
            i++;
          }
          if (d > 0) unclosed = true;
        } else i++;
      }
    }
    words.push(seg.slice(start, Math.min(i, n)));
  }
  const open = words.length > 0 && (unclosed || !/\s$/.test(seg));
  return { words, open };
}

/**
 * Find the command being typed at the end of `prefix` (single line).
 * Returns {words, current, cmd, sub, argIndex} where `current` is the index of the word under the cursor.
 */
function callContext(prefix) {
  let start = 0;
  const stack = [];
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (c === '\\') i++;
    else if (c === '[') { stack.push(start); start = i + 1; }
    else if (c === ']') { if (stack.length) start = stack.pop(); }
    else if (c === ';') start = i + 1;
  }
  const { words, open } = splitWords(prefix.slice(start));
  if (!words.length) return null;
  const current = open ? words.length - 1 : words.length;
  const cmd = words[0];
  let sub = null;
  let argIndex = current - 1;
  if (ensembleNames.includes(cmd) && words.length >= 2 && current >= 2) {
    sub = words[1];
    argIndex = current - 2;
  }
  return { words, current, cmd, sub, argIndex };
}

// ---------- signatures ----------

function normEntry(e) {
  if (!e) return null;
  return Array.isArray(e) ? { sig: e[0], doc: e[1] || '' } : { sig: e.sig, doc: e.doc || '' };
}

const docs = require('./docs.json');   // key ("set" or "string length") -> [English doc or null, Chinese doc]
let docLang = 'en';
/** 'zh' shows the Chinese descriptions of built-in commands where available; anything else shows English. */
function setDocLanguage(lang) { docLang = lang === 'zh' ? 'zh' : 'en'; }
function docLanguage() { return docLang; }
function withDoc(key, e) {
  const d = docs[key];
  let doc = e.doc || (d && d[0]) || '';
  if (docLang === 'zh' && d && d[1]) doc = d[1];
  return { ...e, doc };
}

/** Description of a Tk option such as -text, in the current doc language. */
function optionDoc(opt) {
  const d = docs['opt ' + opt];
  if (docLang === 'zh' && d && d[1]) return d[1];
  return tk.options[opt] || '';
}
/** Description of a method of a handle type (e.g. sqlite3 eval), in the current doc language. */
function handleMethodDoc(type, method, en) {
  const d = docs[`${type} ${method}`];
  return docLang === 'zh' && d && d[1] ? d[1] : en;
}

/** Commands Tcl defines for its own machinery (package loading, logging); not worth offering in completion. */
const internalCommandRe = /^(tclPkg\w*|tclMacPkgSearch|auto_load_index|tclLog|tclParseConfigSpec|tclSetupFile|tcl_\w*(?:Break|Word)\w*)$/;
const isInternalCommand = c => internalCommandRe.test(c);

function builtinEntry(cmd, sub) {
  if (sub && builtins.ensembles[cmd]) {
    const e = normEntry(builtins.ensembles[cmd][sub]);
    if (e) return withDoc(`${cmd} ${sub}`, e);
  }
  const c = normEntry(builtins.commands[cmd]);
  if (c) return withDoc(cmd, c);
  const sc = stdCommandEntry(cmd);
  if (sc) return sc;
  if (builtins.ensembles[cmd]) {
    return { sig: `${cmd} subcommand ?arg ...?`, doc: (docLang === 'zh' ? '子命令:' : 'Subcommands: ') + Object.keys(builtins.ensembles[cmd]).join(', ') };
  }
  return null;
}

/** Nested outline (namespaces contain the procs defined inside them). */
function buildOutline(scan) {
  const nodes = [];
  for (const n of scan.namespaces) {
    nodes.push({ kind: 'namespace', name: n.name, detail: 'namespace', line: n.line, endLine: n.endLine,
      start: n.startIdx, end: n.end, children: [] });
  }
  for (const p of scan.procs) {
    nodes.push({ kind: 'proc', name: p.written, detail: procSignature(p).label, line: p.line, endLine: p.endLine,
      start: p.startIdx, end: p.endIdx, children: [] });
  }
  nodes.sort((a, b) => a.start - b.start || b.end - a.end);
  const roots = [];
  const stack = [];
  for (const n of nodes) {
    while (stack.length && !(n.start >= stack[stack.length - 1].start && n.end <= stack[stack.length - 1].end)) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(n);
    stack.push(n);
  }
  return roots;
}

function tokenizeSig(sig) {
  return sig.match(/\?[^?]*\?|\S+/g) || [];
}

function procSignature(p) {
  if (p.sig !== undefined) {                       // bundled package command: free-form argument text
    return { label: `${p.fq.replace(/^::/, '')} ${p.sig}`.trim(), params: tokenizeSig(p.sig), doc: p.doc || '' };
  }
  const params = p.args.map(a => (a.default !== undefined ? `?${a.name}?` : a.name));
  const display = p.ns ? p.fq : p.name;
  return { label: [display, ...params].join(' '), params, doc: p.doc || '' };
}

/** Find a proc by name among lists of {name, fq, ...}. */
function findProcs(name, lists) {
  const bare = name.replace(/^::/, '');
  const hits = [];
  for (const list of lists) {
    for (const p of list) {
      const fq = p.fq.replace(/^::/, '');
      if (fq === bare || p.name === name || fq.endsWith(`::${bare}`)) hits.push(p);
    }
  }
  return hits;
}

/**
 * Locate calls to known procs in command position (start of a command: line start,
 * after ; [ { ). Returns [{line, start, length}] for semantic highlighting.
 * A small scanner follows the text so that comments, backslash-continued lines
 * and the contents of double-quoted strings (which may span lines; [cmd] inside
 * them is still scanned) are not mistaken for commands.
 */
function procCallTokens(text, lists) {
  const out = [];
  const cache = new Map();
  const known = w => {
    if (!cache.has(w)) cache.set(w, findProcs(w, lists).length > 0);
    return cache.get(w);
  };
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = pos => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const word = /^(?:::)?[A-Za-z_]\w*(?:::\w+)*$/;
  for (const c of scanner.scanCommands(text)) {
    const w = c.words[0];
    if (w.type !== 'bare') continue;
    const name = text.slice(w.start, w.end);
    if (!word.test(name) || !known(name)) continue;
    const line = lineOf(w.start);
    out.push({ line, start: w.start - lineStarts[line], length: name.length });
  }
  return out;
}

/** Resolve signature info for a call context. */
function signatureFor(ctx, procLists) {
  if (!ctx || !ctx.cmd) return null;
  const procs = findProcs(ctx.cmd, procLists);
  let info;
  if (procs.length) {
    info = procSignature(procs[0]);
  } else {
    const entry = builtinEntry(ctx.cmd, ctx.sub) || builtinEntry(ctx.cmd, null);
    if (!entry) return null;
    const tokens = tokenizeSig(entry.sig);
    const skip = ctx.sub && builtins.ensembles[ctx.cmd] && builtins.ensembles[ctx.cmd][ctx.sub] ? 2 : 1;
    info = { label: entry.sig, params: tokens.slice(skip), doc: entry.doc, skip };
  }
  const last = info.params[info.params.length - 1] || '';
  const variadic = /^\?.*\.\.\.\?$/.test(last) || last === '...' || last === 'args';
  // Map typed words to parameters, letting optional "?-flag?" parameters be skipped
  // when the typed word is not a flag.
  const isFlag = p => p !== undefined && p.startsWith('?-');
  const firstArg = ctx.sub ? 2 : 1;
  const done = ctx.words.slice(firstArg, firstArg + Math.max(ctx.argIndex, 0));
  const typing = ctx.current < ctx.words.length ? ctx.words[ctx.current] : '';
  let active = 0;
  for (const w of done) {
    if (!w.startsWith('-')) while (isFlag(info.params[active])) active++;
    active++;
  }
  if (!typing.startsWith('-')) while (isFlag(info.params[active])) active++;
  if (active >= info.params.length) active = variadic ? info.params.length - 1 : info.params.length;
  return { ...info, activeParameter: active };
}

// ---------- Tk helpers ----------

/** Layer what the installed Tk reported over the hand-written tables (null resets). */
function setTkRuntime(data) {
  tkRuntime = data || null;
  for (const cmd of Object.keys(staticEnsembles)) builtins.ensembles[cmd] = { ...staticEnsembles[cmd] };
  if (!tkRuntime) return;
  for (const c of tkRuntime.commands) tkNames.add(c);
  for (const [cmd, subs] of Object.entries(tkRuntime.subs)) {
    if (!staticEnsembles[cmd]) continue;
    const merged = {};
    for (const sub of subs) merged[sub] = staticEnsembles[cmd][sub] || [`${cmd} ${sub} ?arg ...?`, ''];
    builtins.ensembles[cmd] = merged;
  }
}
const tkOptions = cls => (tkRuntime && tkRuntime.widgets[cls]) || tk.widgets[cls] || [];
const tkMethods = cls => (tkRuntime && tkRuntime.methods[cls]) || tk.methods[cls] || null;
const tkMethodDocs = require('./tkmethods.json');
/** Documentation for `$w method` of a widget class -> {sig, doc} | null. Class-specific entries win over generic ones. */
function tkMethodEntry(cls, method, path) {
  const base = (cls || '').replace(/^ttk::/, '');
  const e = (cls && tkMethodDocs[`${cls} ${method}`]) || (base && tkMethodDocs[`${base} ${method}`]) || tkMethodDocs[method];
  if (!e) return null;
  return { sig: e[0].replace(/^PATH/, path || 'PATH'), doc: (docLang === 'zh' && e[2]) ? e[2] : e[1] };
}
/** Hover for the method word in `.w method` (the widget class is taken from its creation in the text). */
function tkMethodDoc(before, word, text) {
  const m = /(\.[\w.]*)\s+$/.exec(before);
  if (!m) return null;
  const cls = tkWidgetMap(text)[m[1]];
  if (!cls || !(tkMethods(cls) || []).includes(word)) return null;
  return tkMethodEntry(cls, word, m[1]);
}
const tkValues = (cls, opt) => (tkRuntime && tkRuntime.values[`${cls}|${opt}`]) || tk.values[opt] || null;
const tkIsWidgetClass = cmd => !!(tk.widgets[cmd] || (tkRuntime && tkRuntime.widgets[cmd]));

const usesTk = text => /package\s+require\s+(?:-exact\s+)?(?:Tk|ttk)\b/i.test(text) || /^#!.*\bwish/m.test(text);

const creatorNames = Object.keys(tk.widgets).filter(k => !tk.geometry.includes(k) && !tk.dialogs.includes(k)).map(k => k.replace(/^ttk::/, ''));
const creatorRe = new RegExp('(?:^|[\\s\\[;{])((?:ttk::)?(?:' + [...new Set(creatorNames)].join('|') + '))\\s+(\\.[\\w.]*)', 'g');

/** pathName -> widget class, from `button .b ...` style creations in the text. */
function tkWidgetMap(text) {
  const map = {};
  let m;
  creatorRe.lastIndex = 0;
  while ((m = creatorRe.exec(text))) map[m[2]] = m[1];
  return map;
}

/** Which Tk "options" table applies to the command being typed: {cls, start} (start = index of first option word). */
function tkTarget(ctx, map) {
  const { cmd, words } = ctx;
  if (tk.geometry.includes(cmd)) return { cls: cmd, start: 1 };
  if (tk.dialogs.includes(cmd)) return { cls: cmd, start: 1 };
  if (tkIsWidgetClass(cmd)) return { cls: cmd, start: 2 };
  if (cmd.startsWith('.') && words[1] === 'configure' && map[cmd]) return { cls: map[cmd], start: 2 };
  return null;
}

/**
 * Completion data for Tk argument positions.
 * -> null | {kind: 'options'|'values'|'methods'|'events', items: [{label, detail}], typing}
 */
function tkCompletion(prefix, text) {
  const ctx = callContext(prefix);
  if (!ctx) return null;
  const { words, current, cmd } = ctx;
  const typing = current < words.length ? words[current] : '';
  const prev = current > 0 ? words[current - 1] : '';
  const map = tkWidgetMap(text);
  if (cmd === 'bind' && current === 2) {
    return { kind: 'events', typing, items: tk.events.map(label => ({ label, detail: 'event' })) };
  }
  if (cmd.startsWith('.') && current === 1) {
    const cls = map[cmd];
    const names = (cls && tkMethods(cls)) || ['configure', 'cget'];
    return { kind: 'methods', typing, items: names.map(label => {
      const e = cls ? tkMethodEntry(cls, label, cmd) : null;
      return { label, detail: e ? e.sig : (cls ? `${cls} method` : 'widget method'), doc: e ? e.doc : undefined };
    }) };
  }
  const target = tkTarget(ctx, map);
  if (!target || current < target.start) return null;
  const opts = tkOptions(target.cls);
  if (prev.startsWith('-') && opts.includes(prev) && !typing.startsWith('-')) {
    const vals = tkValues(target.cls, prev);
    if (!vals) return null;
    return { kind: 'values', typing, items: vals.map(label => ({ label, detail: prev })) };
  }
  const pairStart = !tk.geometry.includes(target.cls) && (current - target.start) % 2 === 0;
  if (typing.startsWith('-') || (typing === '' && pairStart && !prev.startsWith('-'))) {
    return { kind: 'options', typing, items: opts.map(label => ({ label, detail: optionDoc(label) })) };
  }
  return null;
}

/** Documentation for an option word (e.g. "-text") typed after a Tk command. */
function tkOptionDoc(prefixBefore, word, text) {
  const ctx = callContext(prefixBefore);
  if (!ctx) return null;
  const target = tkTarget(ctx, tkWidgetMap(text));
  if (!target || !tkOptions(target.cls).includes(word)) return null;
  const vals = tkValues(target.cls, word);
  const desc = optionDoc(word) || (docLang === 'zh' ? '该控件的选项(暂无说明)。' : 'Option of this widget (no description available).');
  return { sig: `${word}  (${target.cls})`, doc: desc + (vals ? `\n\nValues: ${vals.join(', ')}` : '') };
}


// ---------- Options of core commands (socket -server, lsort -index, ...) ----------

const cmdOptions = require('./cmdoptions.json');   // "cmd" or "cmd sub" -> { "-opt": [en, zh, ?values] }
const pkgData = require('./packages.json');         // bundled docs of standard packages: { packages: {name: {cmds}}, options }
Object.assign(cmdOptions, pkgData.options);
cmdOptions.test = pkgData.options['tcltest::test'];   // after `namespace import ::tcltest::*`

/** The option table for the command being typed: {key, table} or null. */
function cmdOptTable(ctx) {
  if (!ctx) return null;
  const cmd = ctx.cmd.replace(/^::(?=\w)/, '');
  const { words, current } = ctx;
  if (words.length >= 2 && current >= 2 && cmdOptions[`${cmd} ${words[1]}`]) {
    return { key: `${cmd} ${words[1]}`, table: cmdOptions[`${cmd} ${words[1]}`] };
  }
  if (current >= 1 && cmdOptions[cmd]) return { key: cmd, table: cmdOptions[cmd] };
  return null;
}
const cmdOptText = e => (docLang === 'zh' && e[1]) ? e[1] : e[0];

/** Completion data for options (and their values) of core commands, same shape as tkCompletion. */
function cmdOptionCompletion(prefix) {
  const ctx = callContext(prefix);
  const t = cmdOptTable(ctx);
  if (!t) return null;
  const { words, current } = ctx;
  const typing = current < words.length ? words[current] : '';
  const prev = current > 0 ? words[current - 1] : '';
  if (prev.startsWith('-') && t.table[prev] && t.table[prev][2] && !typing.startsWith('-')) {
    return { kind: 'values', typing, items: t.table[prev][2].map(label => ({ label, detail: prev })) };
  }
  if (!typing.startsWith('-')) return null;
  const used = new Set(words.slice(1, current));
  const items = Object.entries(t.table)
    .filter(([o]) => !used.has(o) || o === typing)
    .map(([label, e]) => ({ label, detail: t.key, doc: cmdOptText(e) }));
  return items.length ? { kind: 'options', typing, items } : null;
}

/** Names of the options a command (or command + subcommand) accepts, from the core/package option tables. */
function optionSummary(cmd, sub) {
  const c = cmd.replace(/^::(?=\w)/, '');
  const t = (sub && cmdOptions[`${c} ${sub}`]) || cmdOptions[c];
  return t ? Object.keys(t) : [];
}

/**
 * Extra help for signature help while typing options: what the option under the cursor means (also when the
 * cursor is on its value) and which options are still unused. null if the command has no option table.
 */
function optionHelp(prefix, text) {
  const ctx = callContext(prefix);
  const t = cmdOptTable(ctx);
  const tkTarget_ = ctx ? tkTarget(ctx, tkWidgetMap(text || '')) : null;
  if (!t && !tkTarget_) return null;
  const { words, current } = ctx;
  const typing = current < words.length ? words[current] : '';
  const prev = current > 0 ? words[current - 1] : '';
  let opt = null, before = prefix;
  if (typing.startsWith('-')) { opt = typing; before = prefix.slice(0, prefix.length - typing.length); }
  else if (prev.startsWith('-')) { opt = prev; before = prefix.slice(0, prefix.lastIndexOf(prev)); }
  const out = { option: null, remaining: [] };
  if (opt) out.option = cmdOptionDoc(before, opt) || tkOptionDoc(before, opt, text || '');
  if (t) {
    const used = new Set(words.slice(1, current));
    const dashing = typing.startsWith('-') || words.slice(1, current).some(w => w.startsWith('-'));
    if (dashing) out.remaining = Object.keys(t.table).filter(o => !used.has(o));
  }
  return out.option || out.remaining.length ? out : null;
}


/** Hover documentation for an option word typed after a core command. */
function cmdOptionDoc(prefixBefore, word) {
  const ctx = callContext(prefixBefore);
  const t = cmdOptTable(ctx);
  if (!t || !t.table[word]) return null;
  const e = t.table[word];
  return { sig: `${word}  (${t.key})`, doc: cmdOptText(e) + (e[2] ? `\n\nValues: ${e[2].join(', ')}` : '') };
}


// ---------- Standard-library hints: expr functions, predefined variables, format specs, argument values ----------

const stdlib = require('./stdlib.json');
let envNames = [];
/** Names of environment variables to offer for $env(...) (the editor host's environment). */
function setEnvNames(names) { envNames = [...new Set(names || [])].sort(); }
const zhOr = (e, i) => (docLang === 'zh' && e[i + 1]) ? e[i + 1] : e[i];

/** True when the end of `prefix` is inside an expression argument: expr / if / elseif / while {...}, for {} {...}. */
function inExprContext(prefix) {
  const unclosedFrom = (from) => {
    let d = 1;
    for (let i = from; i < prefix.length; i++) {
      const c = prefix[i];
      if (c === '\\') i++;
      else if (c === '{') d++;
      else if (c === '}') { d--; if (d === 0) return false; }
    }
    return true;
  };
  const re = /(?:^|[\s\[;{])(expr|if|elseif|while)\s+\{/g;
  let m, last = -1;
  while ((m = re.exec(prefix))) last = m.index + m[0].length;
  if (last >= 0 && unclosedFrom(last)) return true;
  const fr = /(?:^|[\s\[;{])for\s+\{/g;
  let f, lastFor = -1;
  while ((f = fr.exec(prefix))) lastFor = f.index + f[0].length;
  if (lastFor >= 0) {
    let d = 1, i = lastFor;
    for (; i < prefix.length && d > 0; i++) {
      if (prefix[i] === '\\') i++;
      else if (prefix[i] === '{') d++;
      else if (prefix[i] === '}') d--;
    }
    if (d === 0) {
      const rest = prefix.slice(i);
      const b = /^\s*\{/.exec(rest);
      if (b && unclosedFrom(i + b[0].length)) return true;
    }
  }
  return /(?:^|[\s\[;{])expr\s+(?!\{)[^\[\]{}]*$/.test(prefix);
}

function specItems(table, extra) {
  return Object.entries(table).map(([label, e]) => ({ label, detail: `%${label}`, doc: zhOr(e, 0) + (extra ? extra(label) : '') }));
}

/** Completion for format strings (format, scan, clock, binary). */
function specCompletion(ctx) {
  const { words, current, cmd } = ctx;
  const raw = current < words.length ? words[current] : '';
  const sub = words[1];
  const prev = current > 0 ? words[current - 1] : '';
  let kind = null;
  if (cmd === 'format' && current === 1) kind = 'format';
  else if (cmd === 'scan' && current === 2) kind = 'scan';
  else if (cmd === 'clock' && (sub === 'format' || sub === 'scan') && prev === '-format') kind = 'clock';
  else if (cmd === 'binary' && ((sub === 'format' && current === 2) || (sub === 'scan' && current === 3))) kind = 'binary';
  if (!kind) return null;
  if (kind === 'binary') {
    const typing = /[A-Za-z@]*$/.exec(raw)[0];
    if (!typing) return null;
    return { kind: 'values', typing, items: specItems(stdlib.binarySpecs).map(i => ({ ...i, detail: 'binary ' + sub })) };
  }
  const at = raw.lastIndexOf('%');
  if (at < 0) return null;
  const tail = raw.slice(at + 1);
  if (!/^[-+ 0#]*(\d+|\*)?(\.(\d+|\*))?(ll|l|h)?[A-Za-z]*$/.test(tail) && !(kind === 'clock' && /^[EO]?[A-Za-z]*$/.test(tail))) return null;
  const typing = /[A-Za-z]*$/.exec(tail)[0];
  const table = kind === 'format' ? stdlib.formatSpecs : kind === 'scan' ? stdlib.scanSpecs : stdlib.clockSpecs;
  return { kind: 'values', typing, items: specItems(table) };
}

// commands whose first argument is usually something else (after 100 ..., binary format ...): offer values only once a letter is typed
const QUIET_VALUES = new Set(['after', 'update', 'binary format', 'binary scan']);
const valueLabel = v => (Array.isArray(v) ? v[0] : v);
/** Completion for words at a fixed position of a command (string is <class>, trace add <type> ...). */
function argValueCompletion(ctx) {
  const { words, current } = ctx;
  const typing = current < words.length ? words[current] : '';
  if (typing.startsWith('-') || typing.startsWith('$') || typing.startsWith('[')) return null;
  if (typing === '' && QUIET_VALUES.has(words[0] + (words.length >= 2 && ['binary'].includes(words[0]) ? ' ' + words[1] : ''))) return null;
  const keys = [];
  if (current > 2 && words.length >= 3) keys.push(`${words[0]} ${words[1]} ${words[2]}`);
  if (current > 1 && words.length >= 2) keys.push(`${words[0]} ${words[1]}`);
  keys.push(words[0]);
  for (const k of keys) {
    const vals = stdlib.argValues[k] && stdlib.argValues[k][String(current)];
    if (!vals) continue;
    return { kind: 'values', typing, items: vals.map(v => ({ label: valueLabel(v), detail: k, doc: Array.isArray(v) ? zhOr([v[1], v[2]], 0) : '' })) };
  }
  return null;
}

/** $tcl_platform(<key>) / $env(<name>) */
function arrayKeyCompletion(prefix) {
  const m = /(?:\$\{?|\b(?:set|unset|append|lappend|incr)\s+)(tcl_platform|env)\((\w*)$/.exec(prefix);
  if (!m) return null;
  const items = m[1] === 'env'
    ? [...new Set([...Object.keys(stdlib.arrayKeys.env), ...envNames])].map(label => {
        const e = stdlib.arrayKeys.env[label];
        return { label, detail: 'env', doc: e ? zhOr(e, 0) : '' };
      })
    : Object.entries(stdlib.arrayKeys.tcl_platform).map(([label, e]) => ({ label, detail: 'tcl_platform', doc: zhOr(e, 0) }));
  return { kind: 'values', typing: m[2], items };
}

/** Math functions inside expressions. */
function exprFunctionCompletion(prefix) {
  const m = /(?:^|[^\w$:.])([A-Za-z_]\w*)$/.exec(prefix);
  if (!m || !inExprContext(prefix.slice(0, prefix.length - m[1].length))) return null;
  const items = Object.entries(stdlib.mathfuncs).map(([label, e]) => ({ label, detail: e[0], doc: zhOr(e, 1), insert: label + '(' }));
  return { kind: 'functions', typing: m[1], items };
}

/** Everything above, in priority order. null if nothing applies. */
function stdCompletion(prefix) {
  const ak = arrayKeyCompletion(prefix);
  if (ak) return ak;
  const ctx = callContext(prefix);
  if (ctx) {
    const sp = specCompletion(ctx);
    if (sp) return sp;
    const av = argValueCompletion(ctx);
    if (av) return av;
  }
  return exprFunctionCompletion(prefix);
}

/** Entry for tcl::mathfunc::NAME / tcl::mathop::NAME commands. */
function stdCommandEntry(name) {
  const m = /^(?:::)?tcl::(mathfunc|mathop)::(.+)$/.exec(name);
  if (!m) return null;
  const e = (m[1] === 'mathfunc' ? stdlib.mathfuncs : stdlib.mathops)[m[2]];
  if (!e) return null;
  return { sig: m[1] === 'mathfunc' ? `tcl::mathfunc::${e[0].replace(/\(.*$/, '')} ${e[0].replace(/^[^(]*\(/, '').replace(/\)$/, '').replace(/,/g, '')}`.trim() : `tcl::mathop::${e[0]}`, doc: zhOr(e, 1) };
}
/** Entries offered when the user types "tcl::" or "::tcl::". */
function stdCommandNames() {
  return [
    ...Object.keys(stdlib.mathfuncs).map(n => `tcl::mathfunc::${n}`),
    ...Object.keys(stdlib.mathops).map(n => `tcl::mathop::${n}`)
  ];
}
function varDoc(name) {
  const e = stdlib.vars[name];
  return e ? zhOr(e, 0) : null;
}
/** Hover for a math function used as name( inside an expression. */
function mathFuncDoc(name) {
  const e = stdlib.mathfuncs[name];
  return e ? { sig: e[0], doc: zhOr(e, 1) } : null;
}


// ---------- Bundled standard packages (http, msgcat, tcltest, platform, opt) ----------

const pkgMemo = new Map();
/**
 * Proc-like entries for the standard packages a file requires, so they get completion, hover,
 * signature help and highlighting like ordinary procs. After `namespace import ::pkg::*` the short names are added too.
 */
function bundledProcs(packages, text, runtime) {
  const names = (packages || []).filter(p => pkgData.packages[p]);
  const imports = [];
  const impRe = /namespace\s+import\s+(?:-force\s+)?(?:::)?([\w:]*?)::(\*|\w+)/g;
  let m;
  while ((m = impRe.exec(text || ''))) imports.push(`${m[1]}::${m[2]}`);
  // a package the interpreter really loaded decides which of its bundled commands exist (versions differ)
  const verified = new Set(runtime && runtime.loaded ? names.filter(n => runtime.loaded.has(n)) : []);
  const available = verified.size ? [...runtime.nsCommands].sort().join(',') : '';
  const key = [docLang, names.join(','), imports.join(','), [...verified].join(','), available].join('|');
  if (pkgMemo.has(key)) return pkgMemo.get(key);
  const out = [];
  for (const [cmd, e] of Object.entries(require('./oo.json').commands)) {     // TclOO is always available
    out.push({ name: cmd.split('::').pop(), fq: '::' + cmd, ns: '::oo', args: [], sig: e[0], doc: zhOr([e[1], e[2]], 0), line: 0, bundled: true });
  }
  for (const pkgName of names) {
    for (const [cmd, e] of Object.entries(pkgData.packages[pkgName].cmds)) {
      if (verified.has(pkgName) && !runtime.nsCommands.has('::' + cmd)) continue;
      const short = cmd.split('::').pop();
      const nsName = cmd.slice(0, cmd.length - short.length - 2);
      const doc = zhOr([e[1], e[2]], 0);
      out.push({ name: short, fq: '::' + cmd, ns: '::' + nsName, args: [], sig: e[0], doc, line: 0, bundled: true });
      if (imports.some(i => i === `${nsName}::*` || i === cmd)) {
        out.push({ name: short, fq: '::' + short, ns: '', args: [], sig: e[0], doc, line: 0, bundled: true });
      }
    }
  }
  if (pkgMemo.size > 50) pkgMemo.clear();
  pkgMemo.set(key, out);
  return out;
}


// ---------- TclOO ----------

const oo = require('./oo');
const zhOO = e => (docLang === 'zh' && e[2]) ? e[2] : e[1];
const ooTriple = (name, e) => ({ label: name, detail: `${name} ${e[0]}`.trim(), doc: zhOO(e) });
// `oo::class create ...`, `oo::object new ...`
stdlib.argValues['oo::class'] = { 1: Object.entries(oo.data.classMethods).map(([k, e]) => [k, e[1], e[2]]) };
stdlib.argValues['oo::object'] = stdlib.argValues['oo::class'];

/** Extra command-position items: declarations inside a class definition, my / self / next inside methods. */
function ooCommandItems(textBefore) {
  const kind = oo.ooContext(textBefore);
  if (!kind) return [];
  if (kind === 'class') return Object.entries(oo.data.decls).map(([k, e]) => ooTriple(k, e));
  return Object.entries(oo.data.methodWords).map(([k, e]) => ooTriple(k, e));
}

/** Signature/documentation for a TclOO definition command or method-only command at this position. */
function ooWordInfo(name, textBefore) {
  const kind = oo.ooContext(textBefore);
  const table = kind === 'class' ? oo.data.decls : kind === 'method' ? oo.data.methodWords : null;
  const entry = table && table[name];
  return entry ? { sig: `${name} ${entry[0]}`.trim(), doc: zhOO(entry) } : null;
}

function ooSignature(prefix, textBefore) {
  const ctx = callContext(prefix);
  const info = ctx && ooWordInfo(ctx.cmd, textBefore);
  if (!info) return null;
  const params = tokenizeSig(info.sig).slice(1);
  const last = params[params.length - 1] || '';
  const variadic = /\.\.\./.test(last);
  let activeParameter = Math.max(0, ctx.argIndex);
  if (activeParameter >= params.length) activeParameter = variadic ? Math.max(0, params.length - 1) : params.length;
  return { label: info.sig, params, doc: info.doc, activeParameter };
}

/** Methods after `$obj `, `Class `, `my `, `self `, `oo::define Class `. */
function ooCompletion(prefix, textBefore, workspaceClasses, scan) {
  const ctx = callContext(prefix);
  if (!ctx) return null;
  const { words, current, cmd } = ctx;
  const typing = current < words.length ? words[current] : '';
  if (typing.startsWith('-') || typing.startsWith('$') || typing.startsWith('[')) return null;
  const isDefine = /^(?:::)?oo::(?:define|objdefine)$/.test(cmd);
  if (!(current === 1 || (isDefine && current === 2))) return null;
  const mk = (label, e, detail) => ({ label, detail: detail || `${label} ${e[0]}`.trim(), doc: zhOO(e) });
  if (isDefine && current === 2) return { kind: 'methods', typing, items: Object.entries(oo.data.decls).map(([k, e]) => mk(k, e)) };
  const ctxKind = oo.ooContext(textBefore);
  const localClasses = oo.parseClasses(textBefore + '\n', scan);
  const classes = workspaceClasses ? oo.mergeClasses([workspaceClasses, localClasses]) : localClasses;
  if ((cmd === 'superclass' || cmd === 'mixin') && ctxKind === 'class') {
    const currentClass = oo.classAt(localClasses, textBefore.length);
    const currentNamespace = currentClass && currentClass.includes('::') ? currentClass.slice(0, currentClass.lastIndexOf('::')) : '';
    const seen = new Set();
    const items = [];
    for (const candidate of classes.keys()) {
      if (candidate === currentClass) continue;
      const cut = candidate.lastIndexOf('::');
      const namespace = cut >= 0 ? candidate.slice(0, cut) : '';
      const label = namespace === currentNamespace ? candidate.slice(cut + 2) : `::${candidate}`;
      if (seen.has(label)) continue;
      seen.add(label);
      items.push({ label, detail: `${cmd === 'superclass' ? 'class' : 'mixin'} ${candidate}`, doc: '' });
    }
    return { kind: 'values', typing, items };
  }
  if (cmd === 'self' && ctxKind === 'method') {
    return { kind: 'methods', typing, items: Object.entries(oo.data.selfSubs).map(([k, e]) => ({ label: k, detail: 'self ' + k, doc: zhOO([0, e[0], e[1]]) })) };
  }
  if (cmd === 'my' && ctxKind === 'method') {
    const cls = oo.classAt(localClasses, textBefore.length);
    const names = cls ? [...oo.methodsOf(classes, cls)] : [];
    const items = names.map(n => ({ label: n, detail: 'method of ' + cls, doc: '' }));
    for (const [k, e] of Object.entries(oo.data.objectMethods)) items.push(mk(k, e));
    return { kind: 'methods', typing, items };
  }
  const name = cmd.replace(/^\$\{?/, '').replace(/\}$/, '');
  const clsName = oo.resolveClass(classes, name, scan, textBefore.length);
  if (clsName) {
    return { kind: 'methods', typing, items: Object.entries(oo.data.classMethods).map(([k, e]) => mk(k, e, `${clsName} ${k} ${e[0]}`.trim())) };
  }
  const inst = oo.parseInstances(textBefore, classes, scan);
  if (inst.has(name)) {
    const cls = inst.get(name);
    const items = [...oo.methodsOf(classes, cls)].filter(n => !/^[A-Z]/.test(n)).map(n => ({ label: n, detail: 'method of ' + cls, doc: '' }));
    const d = oo.data.objectMethods.destroy;
    items.push(mk('destroy', d));
    return { kind: 'methods', typing, items };
  }
  return null;
}


// ---------- Handle objects (sqlite3 db handles etc.) ----------

const handles = require('./handles.json');
const creatorCmds = Object.keys(handles.creators);
const handleRe = new RegExp('(?:^|[\\s\\[;{])(' + creatorCmds.join('|') + ')[ \\t]+(?:-\\w+[ \\t]+)*([A-Za-z_:][\\w:]*)', 'g');
const hname = n => n.replace(/^\$\{?/, '').replace(/\}$/, '').replace(/^::/, '');

let handleRuntime = null;
const staticHandleTypes = JSON.parse(JSON.stringify(handles.types));

/** Layer what the installed library reported over the hand-written handle tables (null resets). */
function setHandleRuntime(data) {
  handleRuntime = data || null;
  handles.types = JSON.parse(JSON.stringify(staticHandleTypes));
  if (!handleRuntime) return;
  for (const [type, rt] of Object.entries(handleRuntime.types || {})) {
    const def = handles.types[type];
    if (!def || !rt.methods.length) continue;
    const methods = {};
    for (const m of rt.methods) methods[m] = def.methods[m] || [`DB ${m} ?arg ...?`, ''];
    def.methods = methods;
    for (const [m, vals] of Object.entries(rt.values || {})) if (vals.length) def.values[m] = vals;
  }
}
/** Handle creator specs for the creators this text uses (for the runtime probe). */
function handleSpecs(text) {
  const used = new Set(Object.values(handleMap(text)));
  return Object.entries(handles.creators).filter(([, c]) => used.has(c.type))
    .map(([command, c]) => ({ type: c.type, package: c.package, command, arg: c.probeArg }));
}

/** handleName -> type, from `sqlite3 db ...` style creations in the text. */
function handleMap(text) {
  const map = {};
  let m;
  handleRe.lastIndex = 0;
  while ((m = handleRe.exec(text))) map[hname(m[2])] = handles.creators[m[1]].type;
  // aliases: `set conn db` / `set conn $db` (repeat so chains work)
  const aliasRe = /(?:^|[\n;\[{])[ \t]*set[ \t]+(\w+)[ \t]+\$?\{?([A-Za-z_:][\w:]*)\}?[ \t]*(?=$|[\n;\]}])/g;
  for (let pass = 0; pass < 3; pass++) {
    aliasRe.lastIndex = 0;
    while ((m = aliasRe.exec(text))) if (map[hname(m[2])] && !map[m[1]]) map[m[1]] = map[hname(m[2])];
  }
  return map;
}

/** Completion for `db <method>` and the value words some methods take. -> null | {kind, typing, items} */
function handleCompletion(prefix, text) {
  const ctx = callContext(prefix);
  if (!ctx) return null;
  const type = handleMap(text)[hname(ctx.cmd)];
  if (!type) return null;
  const def = handles.types[type];
  const typing = ctx.current < ctx.words.length ? ctx.words[ctx.current] : '';
  if (ctx.current === 1) {
    return { kind: 'methods', typing, items: Object.entries(def.methods).map(([label, v]) => ({ label, detail: v[0], doc: handleMethodDoc(type, label, v[1]) })) };
  }
  if (ctx.current === 2 && def.values[ctx.words[1]]) {
    return { kind: 'values', typing, items: def.values[ctx.words[1]].map(label => ({ label, detail: ctx.words[1] })) };
  }
  return null;
}

/** Hover text for `db` or `db method`. */
function handleDoc(prefixBefore, word, text) {
  const map = handleMap(text);
  const words = prefixBefore.trim().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  if (last && map[hname(last)]) {
    const e = handles.types[map[hname(last)]].methods[word];
    if (e) return { sig: e[0].replace(/^DB/, last), doc: handleMethodDoc(map[hname(last)], word, e[1]) };
  }
  const type = map[hname(word)];
  if (type) return { sig: `${word}  (${handles.types[type].label})`, doc: 'Methods: ' + Object.keys(handles.types[type].methods).join(', ') };
  return null;
}

/** Signature help while typing arguments of `db method ...`. */
function handleSignature(ctx, text) {
  if (!ctx || ctx.words.length < 2 || ctx.current < 2) return null;
  const type = handleMap(text)[hname(ctx.cmd)];
  const e = type && handles.types[type].methods[ctx.words[1]];
  if (!e) return null;
  const params = e[0].split(/\s+/).slice(2);
  return { label: e[0].replace(/^DB/, ctx.cmd), doc: handleMethodDoc(type, ctx.words[1], e[1]), params, activeParameter: Math.min(ctx.current - 2, Math.max(params.length - 1, 0)) };
}

module.exports = {
  handles, setHandleRuntime, handleRuntimeData: () => handleRuntime, handleSpecs, handleMap, handleCompletion, handleDoc, handleSignature,
  tk, tkNames, usesTk, setTkRuntime, tkWidgetMap, tkMethodEntry, tkMethodDoc, tkMethodDocs, tkCompletion, tkOptionDoc, cmdOptionCompletion, cmdOptionDoc, cmdOptions, optionSummary, optionHelp,
  bundledProcs, pkgData, ooCompletion, ooCommandItems, ooWordInfo, ooSignature, oo, stdlib, stdCompletion, stdCommandEntry, stdCommandNames, varDoc, mathFuncDoc, inExprContext, setEnvNames,
  builtins, ensembleNames, docLanguage, setDocLanguage, optionDoc, isInternalCommand,
  parseList, matchBrace, readWord, parseArgs,
  scanDocument, analyzeLinePrefix, splitWords, callContext,
  builtinEntry, buildOutline, tokenizeSig, procSignature, findProcs, procCallTokens, signatureFor
};
