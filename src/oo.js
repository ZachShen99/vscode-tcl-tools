'use strict';
// TclOO awareness: classes defined in the file, their methods and instances, and where in a
// class definition / method body the cursor is. Pure functions over text (no VS Code API).

const data = require('./oo.json');
const scanner = require('./scanner');
const symbols = require('./symbols');

function matchBrace(text, i) {
  let d = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}
const strip = n => n.replace(/^::/, '');
const literal = value => value && !/[$\[\\]/.test(value);
const qualify = (name, scan, offset) => {
  if (name.startsWith('::')) return strip(name);
  const ns = scan ? symbols.namespaceAt(scan, offset) : '';
  return strip(`${ns || ''}::${name}`);
};
const addToMap = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};
const sameLocation = (a, b) => (a.uri && a.uri.toString()) === (b.uri && b.uri.toString()) && a.start === b.start && a.end === b.end;
const pushUnique = (array, value) => {
  if (!array.some(existing => sameLocation(existing, value))) array.push(value);
};

/** Classes defined with `oo::class create Name {...}` / `oo::define Name {...}` / `oo::define Name method ...`. */
function parseClasses(text, scan, uri) {
  const commands = (scan && scan.commands) || scanner.scanCommands(text);
  const commandStarts = new Set(commands.map(command => command.words[0] && command.words[0].start));
  const classes = new Map();
  const get = name => {
    if (!classes.has(name)) classes.set(name, { name, methods: new Set(), methodDefs: new Map(), supers: [],
      definitions: [], classRefs: [], ranges: [] });
    return classes.get(name);
  };
  const re = /(?:^|[\s\[;{])(?:::)?oo::(class\s+create|define)\s+((?:::)?[\w:]+)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const invocationStart = m.index + m[0].search(/(?:::)?oo::/);
    if (!commandStarts.has(invocationStart)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    const end = close < 0 ? text.length : close;
    const rawName = m[2];
    if (!literal(rawName)) continue;
    const nameStart = m.index + m[0].lastIndexOf(rawName);
    const c = get(qualify(rawName, scan, nameStart));
    if (m[1] === 'class create') c.definitions.push({ uri, start: nameStart, end: nameStart + rawName.length });
    c.classRefs.push({ target: c.name, uri, start: nameStart, end: nameStart + rawName.length });
    c.ranges.push([open, end]);
    const body = text.slice(open + 1, end);
    for (const mm of body.matchAll(/(?:^|[;\n])[ \t]*(?:method|forward)[ \t]+(?:-\w+[ \t]+)*([\w:]+)/g)) {
      c.methods.add(mm[1]);
      const start = open + 1 + mm.index + mm[0].lastIndexOf(mm[1]);
      addToMap(c.methodDefs, mm[1], { uri, start, end: start + mm[1].length, className: c.name, name: mm[1] });
    }
    for (const mm of body.matchAll(/(?:^|[;\n])[ \t]*(?:superclass|mixin)[ \t]+([^\n;]+)/g)) {
      const segmentStart = open + 1 + mm.index + mm[0].lastIndexOf(mm[1]);
      for (const match of mm[1].matchAll(/(?:::)?[\w:]+/g)) {
        const raw = match[0];
        const start = segmentStart + match.index;
        const target = qualify(raw, scan, start);
        c.supers.push(target);
        c.classRefs.push({ target, uri, start, end: start + raw.length });
      }
    }
  }
  for (const mm of text.matchAll(/(?:^|[\s\[;{])(?:::)?oo::define\s+((?:::)?[\w:]+)\s+(?:method|forward)\s+([\w:]+)/g)) {
    const invocationStart = mm.index + mm[0].search(/(?:::)?oo::/);
    if (!commandStarts.has(invocationStart)) continue;
    const classStart = mm.index + mm[0].indexOf(mm[1]);
    const className = qualify(mm[1], scan, classStart);
    const c = get(className);
    c.classRefs.push({ target: className, uri, start: classStart, end: classStart + mm[1].length });
    c.methods.add(mm[2]);
    const methodStart = mm.index + mm[0].lastIndexOf(mm[2]);
    addToMap(c.methodDefs, mm[2], { uri, start: methodStart, end: methodStart + mm[2].length, className, name: mm[2] });
  }
  for (const mm of text.matchAll(/(?:^|[\s\[;{])(?:::)?oo::define\s+((?:::)?[\w:]+)\s+(?:superclass|mixin)\s+([\w:]+)/g)) {
    const invocationStart = mm.index + mm[0].search(/(?:::)?oo::/);
    if (!commandStarts.has(invocationStart)) continue;
    const classStart = mm.index + mm[0].indexOf(mm[1]);
    const className = qualify(mm[1], scan, classStart);
    const superStart = mm.index + mm[0].lastIndexOf(mm[2]);
    const target = qualify(mm[2], scan, superStart);
    const c = get(className);
    c.classRefs.push({ target: className, uri, start: classStart, end: classStart + mm[1].length });
    c.classRefs.push({ target, uri, start: superStart, end: superStart + mm[2].length });
    c.supers.push(target);
  }
  return classes;
}

function mergeClasses(maps) {
  const merged = new Map();
  for (const classes of maps) for (const [name, source] of classes) {
    if (!merged.has(name)) merged.set(name, { name, methods: new Set(), methodDefs: new Map(), supers: [],
      definitions: [], classRefs: [], ranges: [] });
    const target = merged.get(name);
    source.methods.forEach(method => target.methods.add(method));
    for (const [method, defs] of source.methodDefs || []) for (const def of defs) {
      if (!target.methodDefs.has(method)) target.methodDefs.set(method, []);
      pushUnique(target.methodDefs.get(method), def);
    }
    for (const item of source.supers || []) if (!target.supers.includes(item)) target.supers.push(item);
    for (const key of ['definitions', 'classRefs']) for (const value of source[key] || []) pushUnique(target[key], value);
    for (const range of source.ranges || []) if (!target.ranges.some(existing => existing[0] === range[0] && existing[1] === range[1])) target.ranges.push(range);
  }
  return merged;
}

/** Methods of a class including inherited / mixed-in ones (from classes in the same file). */
function methodsOf(classes, name, seen = new Set()) {
  const out = new Set();
  if (seen.has(name) || !classes.has(name)) return out;
  seen.add(name);
  const c = classes.get(name);
  c.methods.forEach(x => out.add(x));
  c.supers.forEach(s => methodsOf(classes, s, seen).forEach(x => out.add(x)));
  return out;
}

function methodDefinitions(classes, name, method, seen = new Set()) {
  if (seen.has(name) || !classes.has(name)) return [];
  seen.add(name);
  const c = classes.get(name);
  const own = (c.methodDefs && c.methodDefs.get(method)) || [];
  if (own.length) return own;
  return c.supers.flatMap(parent => methodDefinitions(classes, parent, method, seen));
}

function resolveClass(classes, raw, scan, offset) {
  if (!literal(raw)) return null;
  if (raw.startsWith('::')) return classes.has(strip(raw)) ? strip(raw) : null;
  const ns = scan ? symbols.namespaceAt(scan, offset) : '';
  const candidates = ns ? [strip(`${ns}::${raw}`), strip(raw)] : [strip(raw)];
  return candidates.find(name => classes.has(name)) || null;
}

/** Variable / object names -> class name, for `set o [Foo new]` and `Foo create o`. */
function parseInstances(text, classes, scan) {
  const commands = (scan && scan.commands) || scanner.scanCommands(text);
  const commandStarts = new Set(commands.map(command => command.words[0] && command.words[0].start));
  const inst = new Map();
  for (const m of text.matchAll(/(?:^|[\s\[;{])(set|variable)\s+([\w:]+)\s+\[\s*((?:::)?[\w:]+)\s+new\b/g)) {
    const commandStart = m.index + m[0].indexOf(m[1]);
    if (!commandStarts.has(commandStart)) continue;
    const at = m.index + m[0].lastIndexOf(m[3]);
    const cls = resolveClass(classes, m[3], scan, at);
    if (cls) inst.set(m[2], cls);
  }
  for (const m of text.matchAll(/(?:^|[\s\[;{])((?:::)?[\w:]+)\s+create\s+((?:::)?[\w:]+)/g)) {
    const at = m.index + m[0].indexOf(m[1]);
    if (!commandStarts.has(at)) continue;
    const cls = resolveClass(classes, m[1], scan, at);
    if (cls) inst.set(strip(m[2]), cls);
  }
  return inst;
}

function definitionAt(text, scan, localClasses, workspaceClasses, offset) {
  const classes = mergeClasses([workspaceClasses || new Map(), localClasses]);
  for (const c of localClasses.values()) {
    for (const ref of c.classRefs || []) if (ref.start <= offset && offset <= ref.end) {
      const target = classes.get(ref.target);
      return target ? target.definitions : [];
    }
    for (const defs of c.methodDefs ? c.methodDefs.values() : []) {
      for (const def of defs) if (def.start <= offset && offset <= def.end) return [def];
    }
  }
  // scanCommands returns enclosing scripts before their nested commands. Prefer the
  // narrowest command so a call inside `namespace eval` or a method body is not
  // mistaken for the outer declaration.
  const command = ((scan && scan.commands) || scanner.scanCommands(text))
    .filter(candidate => candidate.words.some(word => word.start <= offset && offset <= word.end))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  if (!command) return [];
  const word = index => command.words[index] && command.words[index].type === 'bare'
    ? text.slice(command.words[index].start, command.words[index].end) : '';
  const selected = command.words.findIndex(item => item.start <= offset && offset <= item.end);
  const cmd = word(0);
  if (selected === 0 && ['new', 'create'].includes(word(1))) {
    const cls = resolveClass(classes, cmd, scan, command.start);
    return cls ? classes.get(cls).definitions : [];
  }
  if (selected !== 1) return [];
  const method = word(1);
  let cls = null;
  if (cmd === 'my') cls = classAt(localClasses, command.start);
  else {
    const instances = parseInstances(text.slice(0, command.start), classes, scan);
    const object = cmd.replace(/^\$\{?/, '').replace(/\}$/, '');
    cls = instances.get(object) || null;
  }
  return cls && method ? methodDefinitions(classes, cls, method) : [];
}

const ARGS = '(?:B|\\S+)';   // B = a braced word (see collapse)
const METHOD_HEADER = new RegExp(`^(?:(?:::)?oo::(?:define|objdefine) [\\w:]+ )?(?:self )?(?:method [\\w:]+(?: -\\w+)* ${ARGS}|constructor ${ARGS}|destructor)$`);
const CLASS_HEADER = /^(?:::)?oo::(?:class create [\w:]+|define [\w:]+|objdefine [\w:]+)$/;

/** 'class' inside a class definition script, 'method' inside a method / constructor / destructor body, else null. */
function ooContext(text) {
  const frames = [];            // kind of each open brace
  const cmdStarts = [0];        // start of the current command at each nesting level
  const n = text.length;
  let atCmd = true;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (atCmd && c === '#') { while (i < n && text[i] !== '\n') i++; i--; continue; }
    if (c === '"' ) {
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      atCmd = false; continue;
    }
    if (c === '{') {
      let header = text.slice(cmdStarts[cmdStarts.length - 1], i);
      for (let prev = null; prev !== header;) { prev = header; header = header.replace(/\{[^{}]*\}/g, 'B'); }   // collapse braced words
      header = header.replace(/\s+/g, ' ').trim();
      const parent = frames.length ? frames[frames.length - 1] : null;
      let kind = parent;
      if (METHOD_HEADER.test(header)) kind = 'method';
      else if (CLASS_HEADER.test(header)) kind = 'class';
      frames.push(kind);
      cmdStarts.push(i + 1);
      atCmd = true;
      continue;
    }
    if (c === '}') {
      if (frames.length) { frames.pop(); cmdStarts.pop(); }
      atCmd = false;
      continue;
    }
    if (c === '\n' || c === ';') { cmdStarts[cmdStarts.length - 1] = i + 1; atCmd = true; continue; }
    if (!/\s/.test(c)) atCmd = false;
  }
  return frames.length ? frames[frames.length - 1] : null;
}

/** The class whose definition script contains offset (or null). */
function classAt(classes, offset) {
  for (const c of classes.values()) if (c.ranges.some(([a, b]) => offset > a && offset <= b)) return c.name;
  return null;
}

module.exports = { data, parseClasses, mergeClasses, parseInstances, methodsOf, methodDefinitions, resolveClass,
  definitionAt, ooContext, classAt, strip };
