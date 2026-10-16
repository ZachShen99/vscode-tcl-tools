'use strict';

// VS Code-independent support for literal `source` commands. Tcl can compute
// paths dynamically; those commands are deliberately recorded as dynamic and
// never guessed. The graph is advisory: it ranks definitions reachable from a
// document but does not hide the rest of the workspace.
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const scanner = require('./scanner');

function commandName(text, command) {
  const first = command.words[0];
  if (!first || first.type !== 'bare') return '';
  return text.slice(first.start, first.end).replace(/^::/, '');
}

function pathWord(command, text) {
  if (commandName(text, command) !== 'source') return null;
  const words = command.words;
  const second = words[1] && scanner.wordText(text, words[1]);
  return words[second === '-encoding' ? 3 : 1] || null;
}

function innerRange(text, word) {
  if (word.type === 'brace') return { start: word.start + 1, end: word.open ? word.end : word.end - 1 };
  if (word.type === 'quote') {
    const closed = word.end > word.start + 1 && text[word.end - 1] === '"';
    return { start: word.start + 1, end: closed ? word.end - 1 : word.end };
  }
  return { start: word.start, end: word.end };
}

function literalValue(text, word) {
  if (!word || (word.type === 'brace' && word.open)) return null;
  const range = innerRange(text, word);
  const value = text.slice(range.start, range.end);
  // In braces Tcl performs no substitutions (apart from backslash-newline).
  // Bare and quoted paths containing substitutions or escapes are dynamic.
  if (word.type !== 'brace' && /[$\[\\]/.test(value)) return null;
  return value;
}

/** Literal and dynamic source operands in executable Tcl command positions. */
function sourceReferences(text) {
  const refs = [];
  for (const command of scanner.scanCommands(text)) {
    const word = pathWord(command, text);
    if (!word) continue;
    const range = innerRange(text, word);
    refs.push({ ...range, raw: text.slice(range.start, range.end), value: literalValue(text, word), dynamic: literalValue(text, word) === null });
  }
  return refs;
}

function sourceReferenceAt(text, offset) {
  return sourceReferences(text).find(ref => ref.start <= offset && offset <= ref.end) || null;
}

/**
 * Source operand being edited at `offset`, including a missing operand after
 * `source ` or `source -encoding utf-8 `.
 */
function sourceContext(text, offset) {
  const prefix = text.slice(0, offset);
  const commands = scanner.scanCommands(prefix);
  const command = commands.filter(c => c.start <= offset && commandName(prefix, c) === 'source').sort((a, b) => b.start - a.start)[0];
  if (!command) return null;
  const words = command.words;
  const pathIndex = words[1] && scanner.wordText(prefix, words[1]) === '-encoding' ? 3 : 1;
  if (words.length > pathIndex + 1) return null;
  const word = words[pathIndex];
  if (!word) {
    const previous = words[pathIndex - 1];
    if (!previous || /[;\n]/.test(prefix.slice(previous.end))) return null;
    return { start: offset, end: offset, typed: '', value: '' };
  }
  const range = innerRange(prefix, word);
  if (offset < range.start || offset > range.end || /[;\n]/.test(prefix.slice(word.end))) return null;
  const typed = prefix.slice(range.start, offset);
  const value = word.type === 'brace' && word.open ? typed : literalValue(prefix, word);
  return { ...range, end: offset, typed, value };
}

function uriPath(uri) {
  if (!uri) return '';
  if (typeof uri.fsPath === 'string' && uri.fsPath) return path.normalize(uri.fsPath);
  const value = typeof uri === 'string' ? uri : uri.toString();
  if (/^file:/i.test(value)) {
    try { return path.normalize(fileURLToPath(value)); } catch (e) { /* use URI path below */ }
  }
  if (typeof uri.path === 'string') return path.normalize(uri.path);
  return path.normalize(value);
}

const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const portable = value => value.split(path.sep).join('/');

function pathIndex(entries) {
  const out = new Map();
  for (const entry of entries) {
    const key = pathKey(uriPath(entry.uri));
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(entry);
  }
  return out;
}

function resolveFromIndex(fromUri, ref, indexed, rootPaths) {
  if (!ref || ref.value === null || !ref.value) return null;
  const origin = uriPath(fromUri);
  const requested = ref.value.replace(/[\\/]/g, path.sep);
  const candidates = path.isAbsolute(requested)
    ? [path.normalize(requested)]
    : [path.resolve(path.dirname(origin), requested), ...rootPaths.map(root => path.resolve(root, requested))];
  const exact = new Map();
  for (const candidate of candidates) for (const entry of indexed.get(pathKey(path.normalize(candidate))) || []) {
    exact.set(entry.uri.toString(), entry);
  }
  return exact.size === 1 ? exact.values().next().value : null;
}

/** Resolve a literal source reference to exactly one indexed file. */
function resolveReference(fromUri, ref, entries, roots = []) {
  return resolveFromIndex(fromUri, ref, pathIndex(entries), roots.map(uriPath));
}

/** Files reachable through literal source commands, with shortest distances. */
function dependencyDistances(originUri, entries, roots = []) {
  const byKey = new Map(entries.map(entry => [entry.uri.toString(), entry]));
  const indexed = pathIndex(entries);
  const rootPaths = roots.map(uriPath);
  const start = originUri.toString();
  const distances = new Map([[start, 0]]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const key = queue[cursor];
    const entry = byKey.get(key);
    if (!entry) continue;
    for (const ref of entry.sources || []) {
      const target = resolveFromIndex(entry.uri, ref, indexed, rootPaths);
      if (!target) continue;
      const targetKey = target.uri.toString();
      if (distances.has(targetKey)) continue;
      distances.set(targetKey, distances.get(key) + 1);
      queue.push(targetKey);
    }
  }
  return distances;
}

/** Indexed Tcl files that can complete a literal source operand. */
function completionCandidates(fromUri, typed, entries, roots = []) {
  if (/[$\[]/.test(typed)) return [];
  const origin = uriPath(fromUri);
  const normalizedTyped = typed.replace(/\\/g, '/');
  const folded = process.platform === 'win32' ? normalizedTyped.toLowerCase() : normalizedTyped;
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (entry.uri.toString() === fromUri.toString()) continue;
    const target = uriPath(entry.uri);
    const values = path.isAbsolute(typed)
      ? [portable(target)]
      : [path.dirname(origin), ...roots.map(uriPath)].map(base => portable(path.relative(base, target)));
    for (let value of values) {
      if (normalizedTyped.startsWith('./') && !value.startsWith('../')) value = './' + value;
      const comparable = process.platform === 'win32' ? value.toLowerCase() : value;
      if (!comparable.startsWith(folded) || seen.has(comparable)) continue;
      seen.add(comparable);
      out.push({ value, uri: entry.uri });
    }
  }
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

module.exports = { sourceReferences, sourceReferenceAt, sourceContext, uriPath, resolveReference, dependencyDistances, completionCandidates };
