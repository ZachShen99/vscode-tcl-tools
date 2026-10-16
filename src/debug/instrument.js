'use strict';
// Line-preserving instrumentation: inserts `::__dbg::step LINE FID; ` before every command that sits in
// a script position (top level, and the bodies of well-known control commands). Because the inserted
// text contains no newline, line numbers in error messages and stack traces stay correct.
const { parseScript, listWords } = require('../diagnostics');

function bodyWords(text, words) {
  const lit = w => {
    if (!w || w.kind !== 'bare') return null;
    const t = text.slice(w.start, w.end);
    return /[$\[\\]/.test(t) ? null : t;
  };
  const b = w => (w && w.kind === 'brace' && !w.broken ? [w] : []);
  const name = lit(words[0]);
  if (name === null) return [];
  switch (name) {
    case 'if': {
      const out = [];
      let k = 1;
      while (k < words.length) {
        k++; // skip the condition
        if (lit(words[k]) === 'then') k++;
        out.push(...b(words[k]));
        k++;
        const kw = lit(words[k]);
        if (kw === 'elseif') { k++; continue; }
        if (kw === 'else') { k++; out.push(...b(words[k])); }
        break;
      }
      return out;
    }
    case 'while': return b(words[2]);
    case 'for': return b(words[4]);
    case 'foreach':
    case 'lmap': return words.length >= 4 ? b(words[words.length - 1]) : [];
    case 'catch':
    case 'time': return b(words[1]);
    case 'proc': return words.length === 4 ? b(words[3]) : [];
    case 'test':
    case 'tcltest::test':
    case '::tcltest::test': {
      // tcltest: `test name desc ?constraints? -setup {..} -body {..} -cleanup {..}` or the positional
      // `test name desc ?constraints? body result` form. The scripts run inside the test, so give them breakpoints.
      const out = [];
      if (words.length >= 4 && !/^-/.test(lit(words[3]) || '')) {
        const body = words.length === 5 ? words[3] : words.length === 6 ? words[4] : null;
        if (body) out.push(...b(body));
        return out;
      }
      for (let i = 3; i < words.length - 1; i++) {
        const opt = lit(words[i]);
        if (opt === '-setup' || opt === '-body' || opt === '-cleanup') out.push(...b(words[i + 1]));
      }
      return out;
    }
    case 'namespace': return lit(words[1]) === 'eval' && words.length >= 4 ? b(words[words.length - 1]) : [];
    case 'dict':
      return ['for', 'map', 'with', 'update'].includes(lit(words[1])) ? b(words[words.length - 1]) : [];
    case 'try': {
      const out = b(words[1]);
      let k = 2;
      while (k < words.length) {
        const kw = lit(words[k]);
        if (kw === 'on' || kw === 'trap') { out.push(...b(words[k + 3])); k += 4; }
        else if (kw === 'finally') { out.push(...b(words[k + 1])); k += 2; }
        else k++;
      }
      return out;
    }
    case 'switch': {
      const last = words[words.length - 1];
      if (words.length < 3 || last.kind !== 'brace' || last.broken) return [];
      return listWords(text, last.bodyStart, last.bodyEnd).filter((w, i) => i % 2 === 1 && w.kind === 'brace');
    }
    default: {
      // Database-style commands whose last argument is a script run once per row / inside a transaction:
      //   db eval SQL ?arrayName? script        db transaction ?mode? script
      // (`interp eval` is excluded: that script runs in another interpreter, where our hook does not exist.)
      const sub = lit(words[1]);
      if (name !== 'interp' && sub === 'eval' && (words.length === 4 || words.length === 5)) return b(words[words.length - 1]);
      if (name !== 'interp' && sub === 'transaction' && (words.length === 3 || words.length === 4)) return b(words[words.length - 1]);
      // Callback scripts of Tk-style APIs, run later at global level:
      //   button .b -command {script}     bind w seq {script}     after ms {script}
      const out = [];
      for (let i = 1; i < words.length - 1; i++) {
        if (lit(words[i]) === '-command') out.push(...b(words[i + 1]));
      }
      if (out.length) return out;
      if (name === 'bind' && words.length === 4 && words[3].kind === 'brace' && !words[3].broken) return b(words[3]);
      if (name === 'after' && words.length === 3 && (/^\d+$/.test(lit(words[1]) || '') || lit(words[1]) === 'idle')) return b(words[2]);
      return [];
    }
  }
}

/** `try ... on error {msg opts} {body}` / `trap PATTERN {msg opts} {body}` handlers: [{body, msgVar, optsVar}]. */
function tryHandlers(text, words) {
  const lit = w => (w && w.kind === 'bare' && !/[$\[\\]/.test(text.slice(w.start, w.end)) ? text.slice(w.start, w.end) : null);
  if (lit(words[0]) !== 'try') return [];
  const out = [];
  for (let k = 2; k < words.length;) {
    const kw = lit(words[k]);
    if (kw === 'on' || kw === 'trap') {
      const codeWord = lit(words[k + 1]);
      const vars = words[k + 2], body = words[k + 3];
      const isErr = kw === 'trap' || codeWord === 'error' || codeWord === '1';
      if (isErr && body && body.kind === 'brace' && !body.broken && vars && vars.kind === 'brace' && !vars.broken) {
        const names = listWords(text, vars.bodyStart, vars.bodyEnd).map(w => text.slice(w.start, w.end));
        const ok = n => n && /^[A-Za-z_]\w*$/.test(n);
        if (ok(names[0])) out.push({ body, msgVar: names[0], optsVar: ok(names[1]) ? names[1] : '' });
      }
      k += 4;
    } else if (kw === 'finally') k += 2;
    else k++;
  }
  return out;
}

/** @returns {{code: string, lines: Set<number>, ok: boolean}} lines are 1-based. */
function instrument(text, fid) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = idx => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const diags = [];
  const inserts = [];
  const lines = new Set();
  const walk = (start, end) => {
    for (const words of parseScript(text, start, end, diags)) {
      const first = words[0];
      const line = lineOf(first.start);
      inserts.push({ at: first.start, text: `::__dbg::step ${line} ${fid}; ` });
      lines.add(line);
      for (const w of bodyWords(text, words)) walk(w.bodyStart, w.bodyEnd);
      // "All errors" also stops when a try handler takes an error (including errors raised by built-in commands)
      for (const h of tryHandlers(text, words)) {
        inserts.push({ at: h.body.bodyStart, text: `::__dbg::tryCaught ${h.msgVar} ${h.optsVar || '{}'}; ` });
      }
    }
  };
  walk(0, text.length);
  if (diags.some(d => d.severity === 'error')) return { code: text, lines: new Set(), ok: false };
  inserts.sort((a, c) => c.at - a.at);
  let code = text;
  for (const ins of inserts) code = code.slice(0, ins.at) + ins.text + code.slice(ins.at);
  return { code, lines, ok: true };
}

module.exports = { instrument, bodyWords, tryHandlers };
