'use strict';
// Project configuration file `.vscode/tcl-tools.json` or `.tcl-tools.json` (vscode-independent).
//
//   {
//     "knownCommands": ["set_property"],                    // accepted by the undefined-command check everywhere
//     "commands": { "get_cells": { "sig": "?-filter expr?", "en": "Get cells", "zh": "获取 cell" } },
//     "hosts": {                                            // per-file command tables for host tools (Vivado, Quartus ...)
//       "vivado": {
//         "match": ["**/*.xdc", "constraints/*.tcl"],       // glob patterns on the workspace-relative path
//         "knownCommands": ["get_*"],
//         "commands": { "create_clock": "-period p ?-name n? objects" },
//         "check": false                                    // true: also run the undefined-command check on these files
//       }
//     }
//   }
//
// It is plain JSON on purpose: nothing in it is ever executed, so it also works in untrusted workspaces.

const FILE_NAME = '.tcl-tools.json';
// Looked up in every workspace folder, in this order (later files override earlier `commands`).
const LOCATIONS = ['.tcl-tools.json', '.vscode/tcl-tools.json'];
const isConfigPath = p => /(^|[\\/])(\.tcl-tools\.json|\.vscode[\\/]tcl-tools\.json)$/.test(p || '');
const MAX_COMMANDS = 5000;
const NAME = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;
const TOP_KEYS = new Set(['knownCommands', 'commands', 'hosts', '$schema']);
const HOST_KEYS = new Set(['match', 'knownCommands', 'commands', 'check']);
const COMMAND_KEYS = new Set(['sig', 'en', 'zh', 'doc']);

function readKnown(value, where, out) {
  const names = [];
  if (!Array.isArray(value)) { out.errors.push(`${where}"knownCommands" must be an array of strings`); return names; }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || /\s/.test(item)) out.warnings.push(`${where}ignored knownCommands entry ${JSON.stringify(item)} (must be a non-empty string without spaces)`);
    else names.push(item);
  }
  return names;
}

function readCommands(value, where, out) {
  const commands = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) { out.errors.push(`${where}"commands" must be an object keyed by command name`); return commands; }
  let count = 0;
  for (const [name, entryValue] of Object.entries(value)) {
    if (!NAME.test(name)) { out.warnings.push(`${where}ignored command "${name}" (not a valid command name)`); continue; }
    if (++count > MAX_COMMANDS) { out.warnings.push(`${where}only the first ${MAX_COMMANDS} commands are used`); break; }
    const entry = { sig: '', en: '', zh: '' };
    if (typeof entryValue === 'string') entry.sig = entryValue;
    else if (entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
      for (const key of Object.keys(entryValue)) {
        if (!COMMAND_KEYS.has(key)) out.warnings.push(`${where}command "${name}": unknown key "${key}"`);
        else if (typeof entryValue[key] !== 'string') out.warnings.push(`${where}command "${name}": "${key}" must be a string`);
      }
      const str = k => (typeof entryValue[k] === 'string' ? entryValue[k] : '');
      entry.sig = str('sig'); entry.en = str('en') || str('doc'); entry.zh = str('zh') || str('doc');
    } else { out.warnings.push(`${where}ignored command "${name}" (expected a signature string or an object)`); continue; }
    commands[name.replace(/^::/, '')] = entry;
  }
  return commands;
}

/** Parse and validate; never throws. Returns {knownCommands, commands, hosts:{name:{...}}, errors, warnings}. */
function parse(text) {
  const out = { knownCommands: [], commands: {}, hosts: {}, errors: [], warnings: [] };
  let data;
  try { data = JSON.parse(text); } catch (e) { out.errors.push(`invalid JSON: ${e.message}`); return out; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) { out.errors.push('the top level must be an object'); return out; }
  for (const key of Object.keys(data)) if (!TOP_KEYS.has(key)) out.warnings.push(`unknown key "${key}" (expected knownCommands, commands or hosts)`);
  if (data.knownCommands !== undefined) out.knownCommands = readKnown(data.knownCommands, '', out);
  if (data.commands !== undefined) out.commands = readCommands(data.commands, '', out);
  if (data.hosts !== undefined) {
    if (!data.hosts || typeof data.hosts !== 'object' || Array.isArray(data.hosts)) out.errors.push('"hosts" must be an object keyed by host name');
    else {
      for (const [name, h] of Object.entries(data.hosts)) {
        const where = `host "${name}": `;
        if (!h || typeof h !== 'object' || Array.isArray(h)) { out.warnings.push(`${where}ignored (expected an object)`); continue; }
        for (const key of Object.keys(h)) if (!HOST_KEYS.has(key)) out.warnings.push(`${where}unknown key "${key}"`);
        const host = { match: [], knownCommands: [], commands: {}, check: false };
        if (h.match !== undefined) {
          if (!Array.isArray(h.match) || h.match.some(m => typeof m !== 'string' || !m.trim())) out.errors.push(`${where}"match" must be an array of glob strings`);
          else host.match = h.match;
        }
        if (!host.match.length) out.warnings.push(`${where}has no "match" patterns, so it never applies`);
        if (h.knownCommands !== undefined) host.knownCommands = readKnown(h.knownCommands, where, out);
        if (h.commands !== undefined) host.commands = readCommands(h.commands, where, out);
        if (h.check !== undefined) {
          if (typeof h.check !== 'boolean') out.warnings.push(`${where}"check" must be true or false`);
          else host.check = h.check;
        }
        out.hosts[name] = host;
      }
    }
  }
  return out;
}

/** Merge several parsed configs (later ones win for `commands` and for hosts of the same name). */
function merge(configs) {
  const out = { knownCommands: [], commands: {}, hosts: {}, errors: [], warnings: [] };
  const known = new Set();
  for (const c of configs) {
    for (const k of c.knownCommands) known.add(k);
    Object.assign(out.commands, c.commands);
    Object.assign(out.hosts, c.hosts || {});
  }
  out.knownCommands = [...known];
  return out;
}

/** Glob on a workspace-relative path: `**` any depth, `*` within a segment, `?` one character. No `/` in the pattern means "any folder". */
function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/');
  if (!p.includes('/')) p = '**/' + p;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
const globMatch = (pattern, relPath) => globToRegExp(pattern).test(String(relPath || '').replace(/\\/g, '/').replace(/^\.?\//, ''));

/** Everything that applies to one file: global tables plus those of every host whose `match` fits. */
function resolve(config, relPath) {
  const matched = Object.entries(config.hosts || {}).filter(([, h]) => h.match.some(p => globMatch(p, relPath)));
  const commands = { ...config.commands };
  const known = new Set(config.knownCommands);
  for (const [, h] of matched) {
    Object.assign(commands, h.commands);
    for (const k of h.knownCommands) known.add(k);
  }
  return {
    commands, knownCommands: [...known],
    hosts: matched.map(([name]) => name),
    check: matched.some(([, h]) => h.check),
    checkOff: matched.filter(([, h]) => !h.check).map(([name]) => name)
  };
}

/** Entries in the shape the proc lists use (see core.bundledProcs), so completion, hover and signature help just work. */
function toProcs(config, lang) {
  return Object.entries(config.commands).map(([fq, e]) => {
    const short = fq.split('::').pop();
    const ns = fq.length > short.length ? '::' + fq.slice(0, fq.length - short.length - 2) : '';
    const doc = lang === 'zh' ? (e.zh || e.en) : (e.en || e.zh);
    return { name: short, fq: '::' + fq, ns, args: [], sig: e.sig, doc, line: 0, bundled: true, project: true };
  });
}

/** Names the undefined-command check should accept: knownCommands globs plus every declared command. */
function acceptedNames(config) {
  return [...config.knownCommands, ...Object.keys(config.commands).map(n => n.split('::').pop())];
}

const TEMPLATE = `{
  "knownCommands": [
    "set_property"
  ],
  "commands": {
    "get_cells": {
      "sig": "?-hierarchical? ?-filter expr? ?patterns?",
      "en": "Get cells of the current design",
      "zh": "获取当前设计中的 cell"
    }
  }
}
`;

module.exports = { FILE_NAME, LOCATIONS, isConfigPath, parse, merge, resolve, globMatch, toProcs, acceptedNames, TEMPLATE };
