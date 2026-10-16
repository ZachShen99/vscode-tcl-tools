'use strict';
// Lightweight, vscode-independent Tcl diagnostics.
// Parses the script like Tcl does (commands -> words), recurses into the bodies of well-known
// control commands, and reports: unmatched braces/quotes/brackets, stray "}" and misplaced
// "else", and unbraced expressions (performance + double-substitution hazards).
const { matchBrace, builtins, builtinEntry, tokenizeSig } = require('./core');
const tclSymbols = require('./symbols');

const isWs = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const err = (start, end, message, code) => ({ start, end, severity: 'error', message, code });
const warn = (start, end, message, code, fix) => ({ start, end, severity: 'warning', message, code, fix });

/** Conservative argument bounds for the uniform signature notation in builtins.json. */
function signatureArity(signature) {
  const tokens = tokenizeSig(signature).slice(1);
  if (tokens.includes('...') || /^switch\s/.test(signature)) return null;
  let minimum = 0, maximum = 0;
  for (const token of tokens) {
    const optional = token.startsWith('?') && token.endsWith('?');
    if (token.includes('?') && !optional) return null; // nested/irregular optional notation: do not guess
    const body = optional ? token.slice(1, -1).trim() : token;
    const pieces = body.split(/\s+/).filter(Boolean);
    if (!optional) minimum += pieces.filter(piece => piece !== '...').length;
    if (pieces.includes('...') || (optional && (body === 'options' || body === 'switches' || body.startsWith('-')))) maximum = Infinity;
    else if (Number.isFinite(maximum)) maximum += pieces.length;
  }
  return { minimum, maximum };
}

function checkArity(text, words, label, bounds, code, diags) {
  if (!bounds || words.slice(1).some(word => text.startsWith('{*}', word.start))) return;
  const actual = words.length - 1;
  if (actual >= bounds.minimum && actual <= bounds.maximum) return;
  const expected = !Number.isFinite(bounds.maximum) ? `${bounds.minimum} or more` :
    bounds.minimum === bounds.maximum ? `${bounds.minimum}` : `${bounds.minimum}–${bounds.maximum}`;
  const at = actual > bounds.maximum ? words[bounds.maximum + 1] : words[0];
  diags.push(err(at.start, at.end,
    `Wrong number of arguments for "${label}": expected ${expected}, got ${actual}`, code));
}

/** Index of the ']' matching the '[' at `open` (braces inside are skipped), or -1. */
function matchBracket(text, open, end) {
  let d = 0;
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '{') {
      const m = matchBrace(text, i);
      if (m < 0 || m >= end) return -1;
      i = m;
    } else if (c === '[') d++;
    else if (c === ']') { d--; if (d === 0) return i; }
  }
  return -1;
}

/** Scan one word starting at i. Returns {kind,start,end,next,...}; `end` is the word end, `next` where scanning resumes. */
function scanWord(text, i, end, diags) {
  const c = text[i];
  if (c === '{') {
    if (text.startsWith('{*}', i) && i + 3 < end && !isWs(text[i + 3]) && text[i + 3] !== ';') {
      const w = scanWord(text, i + 3, end, diags);
      return { ...w, start: i };
    }
    const close = matchBrace(text, i);
    if (close < 0 || close >= end) {
      diags.push(err(i, i + 1, 'Unmatched "{": the closing brace is missing', 'unmatched-brace'));
      return { kind: 'brace', start: i, end, next: end, bodyStart: i + 1, bodyEnd: end, broken: true };
    }
    let j = close + 1;
    const junk = j;
    while (j < end && !isWs(text[j]) && text[j] !== ';') j++;
    if (j > junk) diags.push(err(junk, j, 'Extra characters after closing brace', 'extra-chars'));
    return { kind: 'brace', start: i, end: close + 1, next: j, bodyStart: i + 1, bodyEnd: close };
  }
  if (c === '"') {
    let j = i + 1;
    let reported = false;
    while (j < end && text[j] !== '"') {
      if (text[j] === '\\') j += 2;
      else if (text[j] === '[') {
        const m = matchBracket(text, j, end);
        if (m < 0) {
          diags.push(err(j, j + 1, 'Unmatched "[": the closing bracket is missing', 'unmatched-bracket'));
          reported = true;
          j = end;
          break;
        }
        j = m + 1;
      } else j++;
    }
    if (j >= end) {
      if (!reported) diags.push(err(i, i + 1, 'Unmatched quote: the closing " is missing', 'unmatched-quote'));
      return { kind: 'quote', start: i, end, next: end, broken: true };
    }
    let k = j + 1;
    const junk = k;
    while (k < end && !isWs(text[k]) && text[k] !== ';') k++;
    if (k > junk) diags.push(err(junk, k, 'Extra characters after closing quote', 'extra-chars'));
    return { kind: 'quote', start: i, end: j + 1, next: k };
  }
  let j = i;
  while (j < end && !isWs(text[j]) && text[j] !== ';') {
    const ch = text[j];
    if (ch === '\\') {
      if (text[j + 1] === '\n') break; // backslash-newline separates words
      j += 2;
      continue;
    }
    if (ch === '[') {
      const m = matchBracket(text, j, end);
      if (m < 0) {
        diags.push(err(j, j + 1, 'Unmatched "[": the closing bracket is missing', 'unmatched-bracket'));
        j = end;
        break;
      }
      j = m + 1;
      continue;
    }
    if (ch === '$' && text[j + 1] === '{') {
      const m = text.indexOf('}', j + 2);
      if (m >= 0 && m < end) { j = m + 1; continue; }
    }
    j++;
  }
  return { kind: 'bare', start: i, end: j, next: j };
}

/** Split [start,end) into commands; each command is an array of words. */
function parseScript(text, start, end, diags) {
  const commands = [];
  let i = start;
  while (i < end) {
    while (i < end && (isWs(text[i]) || text[i] === ';' || (text[i] === '\\' && text[i + 1] === '\n'))) {
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= end) break;
    if (text[i] === '#') {
      while (i < end && text[i] !== '\n') { if (text[i] === '\\' && text[i + 1] === '\n') i++; i++; }
      continue;
    }
    const words = [];
    while (i < end) {
      while (i < end && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' ||
                         (text[i] === '\\' && text[i + 1] === '\n'))) {
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i >= end || text[i] === '\n' || text[i] === ';') break;
      const w = scanWord(text, i, end, diags);
      words.push(w);
      i = Math.max(w.next, i + 1);
      if (w.broken) i = end;
    }
    if (words.length) commands.push(words);
  }
  return commands;
}

/** Words of a list-like brace body with offsets (used for switch pattern/body pairs). */
function listWords(text, start, end) {
  const out = [];
  const sink = [];
  let i = start;
  while (i < end) {
    while (i < end && isWs(text[i])) i++;
    if (i >= end) break;
    const w = scanWord(text, i, end, sink);
    out.push(w);
    i = Math.max(w.next, i + 1);
  }
  return out;
}

function eachBracket(text, w, cb) {
  for (let j = w.start; j < w.end; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '[') {
      const m = matchBracket(text, j, w.end);
      if (m < 0) return;
      cb(j + 1, m);
      j = m;
    }
  }
}

function analyze(text, start, end, diags, context) {
  const lit = w => {
    if (!w || w.kind !== 'bare') return null;
    const t = text.slice(w.start, w.end);
    return /[$\[\\]/.test(t) ? null : t;
  };
  const body = w => { if (w && w.kind === 'brace' && !w.broken) analyze(text, w.bodyStart, w.bodyEnd, diags, context); };
  const needsSubst = t => /[$\[]/.test(t);

  const cond = w => {
    if (!w || w.kind === 'brace') return;
    const t = text.slice(w.start, w.end);
    if (!needsSubst(t)) return;
    if (w.kind === 'bare' && /^\$[\w:]+$/.test(t)) return; // `if $flag {...}` is a common, harmless idiom
    const inner = w.kind === 'quote' ? t.slice(1, -1) : t;
    const fix = /[{}"\\]/.test(inner) ? undefined : { start: w.start, end: w.end, text: `{${inner}}` };
    diags.push(warn(w.start, w.end, 'Unbraced expression: write it as {…} so Tcl compiles it once and avoids double substitution',
      'unbraced-expr', fix));
  };

  const exprArgs = args => {
    if (!args.length) return;
    if (args.length === 1) return cond(args[0]);
    if (args.some(w => w.kind === 'brace')) return;
    const a = args[0].start;
    const b = args[args.length - 1].end;
    const t = text.slice(a, b);
    if (!needsSubst(t)) return;
    const fix = /[{}"\\]/.test(t) ? undefined : { start: a, end: b, text: `{${t}}` };
    diags.push(warn(a, b, 'Unbraced expression: write it as {…} so Tcl compiles it once and avoids double substitution',
      'unbraced-expr', fix));
  };

  for (const words of parseScript(text, start, end, diags)) {
    for (const w of words) {
      if (w.kind !== 'brace') eachBracket(text, w, (s, e) => analyze(text, s, e, diags, context));
    }
    const name = lit(words[0]);
    if (name === null) continue;
    const first = words[0];
    if (name.startsWith('}')) {
      diags.push(err(first.start, first.end, 'Unexpected "}": no matching open brace', 'stray-brace'));
      continue;
    }
    if (context && context.scan && context.definitions) {
      const definitions = context.definitions;
      const candidates = tclSymbols.procCandidates(name, context.scan, first.start);
      const possibleProc = definitions.some(definition => candidates.includes(definition.fq));
      const target = tclSymbols.resolveProc(name, context.scan, first.start, definitions);
      if (target) {
        const variadic = target.args.length > 0 && target.args[target.args.length - 1].name === 'args' &&
          target.args[target.args.length - 1].default === undefined;
        const fixed = variadic ? target.args.slice(0, -1) : target.args;
        checkArity(text, words, target.fq.replace(/^::/, ''), {
          minimum: fixed.filter(arg => arg.default === undefined).length,
          maximum: variadic ? Infinity : fixed.length
        }, 'wrong-proc-args', diags);
      } else if (!possibleProc) {
        const command = name.replace(/^::/, '');
        const subcommands = builtins.ensembles[command];
        const subcommand = lit(words[1]);
        let resolvedSub = null;
        if (subcommands && subcommand) {
          const matches = Object.keys(subcommands).filter(candidate => candidate.startsWith(subcommand));
          if (!matches.length) {
            diags.push(err(words[1].start, words[1].end,
              `Unknown subcommand "${subcommand}" for "${command}"`, 'unknown-subcommand'));
          } else if (matches.length > 1 && !matches.includes(subcommand)) {
            diags.push(err(words[1].start, words[1].end,
              `Ambiguous subcommand "${subcommand}" for "${command}": ${matches.join(', ')}`, 'ambiguous-subcommand'));
          } else resolvedSub = matches.includes(subcommand) ? subcommand : matches[0];
        }
        const entry = builtinEntry(command, resolvedSub);
        if (entry && !(subcommands && subcommand && !resolvedSub)) {
          checkArity(text, words, resolvedSub ? `${command} ${resolvedSub}` : command,
            signatureArity(entry.sig), 'wrong-builtin-args', diags);
        }
        if (!entry && !subcommands && context.undefinedCommands) {
          const unknown = context.undefinedCommands.check(command);
          if (unknown) diags.push(warn(first.start, first.end, unknown.message, 'undefined-command'));
        }
      }
    }
    switch (name) {
      case 'else':
      case 'elseif':
        diags.push(err(first.start, first.end, `"${name}" must be on the same line as the closing "}" of the previous block`, 'else-newline'));
        break;
      case 'expr': exprArgs(words.slice(1)); break;
      case 'if': {
        let k = 1;
        while (k < words.length) {
          cond(words[k]); k++;
          if (lit(words[k]) === 'then') k++;
          body(words[k]); k++;
          const kw = lit(words[k]);
          if (kw === 'elseif') { k++; continue; }
          if (kw === 'else') { k++; body(words[k]); }
          break;
        }
        break;
      }
      case 'while': cond(words[1]); body(words[2]); break;
      case 'for': body(words[1]); cond(words[2]); body(words[3]); body(words[4]); break;
      case 'foreach':
      case 'lmap': if (words.length >= 4) body(words[words.length - 1]); break;
      case 'catch': body(words[1]); break;
      case 'time': body(words[1]); break;
      case 'proc': if (words.length === 4) body(words[3]); break;
      case 'namespace': if (lit(words[1]) === 'eval' && words.length >= 4) body(words[words.length - 1]); break;
      case 'dict':
        if (['for', 'map', 'with', 'update'].includes(lit(words[1]))) body(words[words.length - 1]);
        break;
      case 'try': {
        body(words[1]);
        let k = 2;
        while (k < words.length) {
          const kw = lit(words[k]);
          if (kw === 'on' || kw === 'trap') { body(words[k + 3]); k += 4; }
          else if (kw === 'finally') { body(words[k + 1]); k += 2; }
          else k++;
        }
        break;
      }
      case 'switch': {
        const last = words[words.length - 1];
        if (words.length >= 3 && last.kind === 'brace' && !last.broken) {
          listWords(text, last.bodyStart, last.bodyEnd).forEach((w, idx) => {
            if (idx % 2 === 1 && w.kind === 'brace') body(w);
          });
        }
        break;
      }
      default: break;
    }
  }
}

function diagnose(text, context) {
  const diags = [];
  analyze(text, 0, text.length, diags, context);
  diags.sort((a, b) => a.start - b.start);
  // `# tcl-tools: ignore` on the same or the previous line silences an undefined-command warning
  const ignore = /#\s*tcl-tools:\s*ignore\b/;
  return diags.filter(d => {
    if (d.code !== 'undefined-command') return true;
    const lineStart = text.lastIndexOf('\n', d.start - 1) + 1;
    const lineEnd = text.indexOf('\n', d.start);
    const prevStart = lineStart > 0 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0;
    return !ignore.test(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)) &&
      !(lineStart > 0 && ignore.test(text.slice(prevStart, lineStart)));
  });
}

module.exports = { diagnose, parseScript, listWords, scanWord, matchBracket, signatureArity };
