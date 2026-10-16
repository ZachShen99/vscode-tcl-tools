'use strict';
// Debug Adapter Protocol implementation for Tcl (vscode-independent, testable with plain node).
// Architecture: this adapter listens on a localhost TCP port, spawns `tclsh agent.tcl <port> <program> ...`,
// instruments each sourced file on demand (see instrument.js), and drives the agent over a line protocol.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { instrument } = require('./instrument');

const AGENT = path.join(__dirname, 'agent.tcl');
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
const unesc = s => s.replace(/\\(\\|n|t|r)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\'));
const STEP_NOISE = /::__dbg::step \d+ \d+; /g;

function canonical(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}
// Tcl encoding names -> WHATWG labels understood by TextDecoder.
const TCL_ENCODINGS = {
  'utf-8': 'utf-8', 'iso8859-1': 'iso-8859-1', 'iso8859-2': 'iso-8859-2', 'iso8859-15': 'iso-8859-15',
  'cp1250': 'windows-1250', 'cp1251': 'windows-1251', 'cp1252': 'windows-1252', 'cp1253': 'windows-1253',
  'cp1254': 'windows-1254', 'cp1256': 'windows-1256', 'cp936': 'gbk', 'gbk': 'gbk', 'gb2312': 'gb2312',
  'gb18030': 'gb18030', 'big5': 'big5', 'cp950': 'big5', 'shiftjis': 'shift_jis', 'cp932': 'shift_jis',
  'euc-jp': 'euc-jp', 'euc-kr': 'euc-kr', 'cp949': 'euc-kr', 'koi8-r': 'koi8-r', 'koi8-u': 'koi8-u',
  'unicode': 'utf-16le', 'utf-16': 'utf-16le', 'ascii': 'windows-1252',
};
// Decode a script file. Without an explicit encoding it must be valid UTF-8; otherwise (or for an encoding we cannot
// decode here) return null so the agent falls back to Tcl's own `source`, which is exact but uninstrumented.
function readSource(p, tclEncoding) {
  const buf = fs.readFileSync(p);
  const label = tclEncoding ? TCL_ENCODINGS[String(tclEncoding).toLowerCase()] : 'utf-8';
  if (!label) return null;
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf).replace(/^\ufeff/, '');
  } catch (e) { return null; }
}

// errorInfo starts with the error message itself; drop that duplicate and the instrumentation noise.
function cleanInfo(message, info) {
  let s = (info || '').replace(STEP_NOISE, '');
  if (message && s.startsWith(message)) s = s.slice(message.length).replace(/^\n/, '');
  return s;
}

class TclDebugAdapter {
  constructor(send) {
    this.sendRaw = send;
    this.seq = 1;
    this.bps = new Map();        // canonical path -> [{line, condition}]
    this.display = new Map();    // canonical path -> path as VS Code knows it
    this.fids = new Map();       // canonical path -> file id
    this.nextFid = 1;
    this.varPaths = new Map();   // `${ref}\0${name}` -> {level, path} for setVariable
    this.refs = new Map();       // variablesReference -> {scope, level, name}
    this.nextRef = 1;
    this.pending = new Map();    // agent request id -> {resolve, reject, kind}
    this.nextReq = 1;
    this.stopped = false;
    this.stopLevel = 0;
    this.agentReady = false;
    this.configDone = false;
    this.started = false;
    this.finished = false;
    this.exitCode = null;
    this.buffer = '';
    this.reverse = new Map();    // reverse requests (runInTerminal) awaiting a response
    this.stopOnUncaught = true;
    this.stopOnAll = false;
    this.lastException = null;
  }

  // ---------- DAP plumbing ----------
  send(msg) { msg.seq = this.seq++; this.sendRaw(msg); }
  event(event, body) { this.send({ type: 'event', event, body }); }
  respond(req, body = {}, success = true, message) {
    this.send({ type: 'response', request_seq: req.seq, command: req.command, success, body, ...(message ? { message } : {}) });
  }
  output(text, category = 'console') { this.event('output', { category, output: text }); }

  /** Send a reverse request to the client and wait for its response. */
  sendRequest(command, args, ms = 10000) {
    const seq = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.reverse.delete(seq); reject(new Error(`No answer to "${command}"`)); }, ms);
      this.reverse.set(seq, { resolve: r => { clearTimeout(timer); resolve(r); } });
      this.send({ type: 'request', command, arguments: args });
    });
  }

  async handleMessage(msg) {
    if (msg && msg.type === 'response') {
      const p = this.reverse.get(msg.request_seq);
      if (p) { this.reverse.delete(msg.request_seq); p.resolve(msg); }
      return;
    }
    if (!msg || msg.type !== 'request') return;
    const handler = this[`on_${msg.command}`];
    if (!handler) return this.respond(msg, {}, false, `Unsupported request: ${msg.command}`);
    try { await handler.call(this, msg); } catch (e) { this.respond(msg, {}, false, e && e.message ? e.message : String(e)); }
  }

  // ---------- requests ----------
  on_initialize(req) {
    this.canRunInTerminal = !!(req.arguments && req.arguments.supportsRunInTerminalRequest);
    this.respond(req, {
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      supportsExceptionInfoRequest: true,
      exceptionBreakpointFilters: [
        { filter: 'uncaught', label: 'Uncaught errors', default: true },
        { filter: 'all', label: 'All errors (including caught)', default: false, description: 'Stop on every `error` call and every error caught by `catch`' }
      ],
      supportsSetVariable: true
    });
    this.event('initialized');
  }

  async on_launch(req) {
    const a = req.arguments || {};
    if (!a.program) throw new Error('launch.program is required');
    const program = path.resolve(a.cwd || process.cwd(), a.program);
    if (!fs.existsSync(program)) throw new Error(`Program not found: ${program}`);
    this.display.set(canonical(program), program);
    this.stopOnEntry = a.stopOnEntry === true;
    await this.startServer();
    const exe = a.interpreter || 'tclsh';
    const args = [...(a.interpreterArgs || []), AGENT, String(this.port), program, ...(a.args || []).map(String)];
    const cwd = a.cwd || path.dirname(program);
    const useTerminal = (a.console || 'integratedTerminal') === 'integratedTerminal' && this.canRunInTerminal;
    if (useTerminal) {
      const r = await this.sendRequest('runInTerminal', {
        kind: 'integrated', title: 'Tcl Debug', cwd, args: [exe, ...args], env: a.env || {}, argsCanBeInterpretedByShell: false
      });
      if (!r.success) throw new Error(`Could not start the terminal: ${r.message || 'unknown error'}`);
      this.termPid = r.body && (r.body.processId || r.body.shellProcessId);
    } else {
      this.child = spawn(exe, args, { cwd, env: { ...process.env, ...(a.env || {}) }, windowsHide: true });
      this.child.stdout.on('data', d => this.output(d.toString(), 'stdout'));
      this.child.stderr.on('data', d => this.output(d.toString(), 'stderr'));
      this.child.on('error', e => {
        this.output(`Could not start "${exe}": ${e.message}\n`, 'stderr');
        this.finish(1);
      });
      this.child.on('exit', code => this.finish(this.exitCode !== null ? this.exitCode : code));
    }
    this.helloTimer = setTimeout(() => {
      if (!this.agentReady) {
        this.output('The Tcl debug agent did not connect within 15 s (is "' + exe + '" a plain tclsh 8.5+?).\n', 'stderr');
        this.kill();
      }
    }, 15000);
    this.respond(req);
  }

  on_setBreakpoints(req) {
    const a = req.arguments;
    const src = a.source && a.source.path;
    const reqs = a.breakpoints || (a.lines || []).map(line => ({ line }));
    const canon = canonical(src);
    this.display.set(canon, src);
    let lines = new Set();
    try { lines = instrument(readSource(canon), 0).lines; } catch (e) { /* unreadable: leave unverified */ }
    const sorted = [...lines].sort((x, y) => x - y);
    const stored = [];
    const result = reqs.map(b => {
      const line = sorted.find(l => l >= b.line);
      if (line === undefined) return { verified: false, line: b.line, message: 'No executable command at or after this line' };
      stored.push({ line, condition: b.condition || '', logMessage: b.logMessage || '', hit: b.hitCondition || '' });
      return { verified: true, line };
    });
    this.bps.set(canon, stored);
    if (this.started) this.sendBreakpoints(canon);
    this.respond(req, { breakpoints: result });
  }

  on_setExceptionBreakpoints(req) {
    const filters = (req.arguments && req.arguments.filters) || [];
    this.stopOnUncaught = filters.includes('uncaught');
    this.stopOnAll = filters.includes('all');
    if (this.started) this.write('exc', this.stopOnUncaught ? 1 : 0, this.stopOnAll ? 1 : 0);
    this.respond(req, {});
  }

  on_exceptionInfo(req) {
    const e = this.lastException;
    if (!e) throw new Error('No exception');
    this.respond(req, {
      exceptionId: 'TclError', description: e.message, breakMode: e.caught ? 'always' : 'unhandled',
      details: { stackTrace: e.info }
    });
  }

  on_configurationDone(req) {
    this.configDone = true;
    this.respond(req);
    this.maybeStart();
  }

  on_threads(req) { this.respond(req, { threads: [{ id: 1, name: 'main' }] }); }

  async on_stackTrace(req) {
    if (!this.stopped) return this.respond(req, { stackFrames: [], totalFrames: 0 });
    const r = await this.ask('stack');
    const frames = [];
    const n = Number(r[0]);
    for (let i = 0; i < n; i++) {
      const [name, file, line] = r.slice(1 + i * 3, 4 + i * 3);
      const level = this.stopLevel - i;
      const frame = { id: level + 1, name, line: Number(line) || 0, column: 1 };
      if (file) frame.source = { name: path.basename(file), path: this.display.get(file) || file };
      frames.push(frame);
    }
    this.respond(req, { stackFrames: frames, totalFrames: frames.length });
  }

  async on_scopes(req) {
    const level = req.arguments.frameId - 1;
    const scopes = [];
    if (level > 0) scopes.push({ name: 'Locals', variablesReference: this.newRef({ scope: 'local', level }), expensive: false });
    if (level > 0 && this.stopped) {
      const namespace = (await this.ask('namespace', level))[0] || '::';
      if (namespace !== '::') scopes.push({ name: 'Namespace Variables',
        variablesReference: this.newRef({ scope: 'namespace', level: 0, path: namespace }), expensive: false });
    }
    scopes.push({ name: 'Globals', variablesReference: this.newRef({ scope: 'global', level: 0 }), expensive: level > 0 });
    scopes.push({ name: 'Commands', variablesReference: this.newRef({ scope: 'commands', level: 0 }), expensive: true });
    this.respond(req, { scopes });
  }

  async on_variables(req) {
    const ref = this.refs.get(req.arguments.variablesReference);
    if (!ref || !this.stopped) return this.respond(req, { variables: [] });
    const r = await this.ask('vars', ref.level, ref.scope, ref.path || '');
    const n = Number(r[0]);
    const variables = [];
    for (let i = 0; i < n; i++) {
      const [name, value, type, hasChildren, vpath] = r.slice(1 + i * 5, 6 + i * 5);
      const v = { name, value, type, variablesReference: 0 };
      if (vpath) this.varPaths.set(`${req.arguments.variablesReference}\0${name}`, { level: ref.level, path: vpath });
      if (hasChildren === '1' && vpath) v.variablesReference = this.newRef({ scope: 'value', level: ref.level, path: vpath });
      variables.push(v);
    }
    this.respond(req, { variables });
  }

  async on_setVariable(req) {
    const a = req.arguments;
    if (!this.stopped) throw new Error('Not stopped');
    const info = this.varPaths.get(`${a.variablesReference}\0${a.name}`);
    if (!info) throw new Error('This value cannot be edited');
    const r = await this.ask('setvar', info.level, info.path, a.value);
    if (r[0] !== '0') throw new Error(r[1]);
    const ref = r[3] === '1' && r[4] ? this.newRef({ scope: 'value', level: info.level, path: r[4] }) : 0;
    this.respond(req, { value: r[1], type: r[2], variablesReference: ref });
  }

  async on_evaluate(req) {
    const a = req.arguments;
    if (!this.stopped) throw new Error('Not stopped');
    const level = a.frameId ? a.frameId - 1 : this.stopLevel;
    const r = await this.ask('eval', level, a.expression);
    if (r[0] !== '0') throw new Error(r[1]);
    const ref = r[3] === '1' && r[4] ? this.newRef({ scope: 'value', level, path: r[4] }) : 0;
    this.respond(req, { result: r[1], type: r[2], variablesReference: ref });
  }

  on_continue(req) { this.resume('continue'); this.respond(req, { allThreadsContinued: true }); }
  on_next(req) { this.resume('next'); this.respond(req); }
  on_stepIn(req) { this.resume('stepin'); this.respond(req); }
  on_stepOut(req) { this.resume('stepout'); this.respond(req); }
  on_pause(req) { this.write('pause'); this.respond(req); }

  on_terminate(req) { this.kill(); this.respond(req); }
  on_disconnect(req) { this.kill(); this.respond(req); this.dispose(); }

  // ---------- agent connection ----------
  startServer() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(sock => this.onAgentConnection(sock));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(); });
    });
  }

  onAgentConnection(sock) {
    this.agent = sock;
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (line) this.onAgentLine(line.split('\t').map(unesc));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('The program has exited'));
      this.pending.clear();
      // Terminal mode has no child process to watch: the agent closing the socket means the program ended.
      if (!this.child) setTimeout(() => this.finish(this.exitCode !== null ? this.exitCode : 0), 200);
    });
  }

  write(...fields) {
    if (this.agent && !this.agent.destroyed) this.agent.write(fields.map(esc).join('\t') + '\n');
  }

  ask(kind, ...fields) {
    const id = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Debug agent did not answer "${kind}"`)); }, 10000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.write(kind, id, ...fields);
    });
  }

  onAgentLine(f) {
    switch (f[0]) {
      case 'hello': this.agentReady = true; clearTimeout(this.helloTimer); this.maybeStart(); break;
      case 'needsource': this.serveSource(f[1], f[2]); break;
      case 'stopped': this.onStopped(f[1], f[2]); break;
      case 'exited': this.exitCode = Number(f[1]); break;
      case 'uncaught':
        this.lastException = { message: f[1], info: cleanInfo(f[1], f[2]) };
        this.output(`${this.lastException.message}\n${this.lastException.info}\n`, 'stderr');
        this.exitCode = 1;
        break;
      case 'caught':
        this.lastException = { message: f[1], info: cleanInfo(f[1], f[2]), caught: true };
        break;
      case 'log': this.output(`${f[1]}\n`, 'console'); break;
      case 'stack': case 'vars': case 'eval': case 'setvar': case 'namespace': {
        const p = this.pending.get(Number(f[1]));
        if (p) { this.pending.delete(Number(f[1])); p.resolve(f.slice(2)); }
        break;
      }
      default: break;
    }
  }

  serveSource(p, encoding) {
    const canon = canonical(p);
    if (!this.fids.has(canon)) this.fids.set(canon, this.nextFid++);
    let code = '';
    let native = '';
    try {
      const text = readSource(canon, encoding);
      if (text === null) native = 'native';     // undecodable here: run it through Tcl's own source
      else code = instrument(text, this.fids.get(canon)).code;
    } catch (e) {
      code = `error {cannot read ${p}}`;
    }
    this.write('source', this.fids.get(canon), canon, code, native);
  }

  sendBreakpoints(canon) {
    const list = this.bps.get(canon) || [];
    this.write('bp', canon, list.length, ...list.flatMap(b => [b.line, b.condition, b.logMessage, b.hit]));
  }

  maybeStart() {
    if (this.started || !this.agentReady || !this.configDone) return;
    this.started = true;
    for (const canon of this.bps.keys()) this.sendBreakpoints(canon);
    this.write('exc', this.stopOnUncaught ? 1 : 0, this.stopOnAll ? 1 : 0);
    this.write('go', this.stopOnEntry ? 1 : 0);
  }

  onStopped(reason, level) {
    this.stopped = true;
    this.stopLevel = Number(level) || 0;
    this.refs.clear(); this.varPaths.clear();
    const body = { reason, threadId: 1, allThreadsStopped: true };
    if (reason === 'exception' && this.lastException) {
      body.description = this.lastException.caught ? 'Tcl error (caught)' : 'Uncaught Tcl error';
      body.text = this.lastException.message;
    }
    this.event('stopped', body);
  }

  resume(cmd) {
    this.stopped = false;
    this.refs.clear(); this.varPaths.clear();
    this.write(cmd);
  }

  newRef(info) { const id = this.nextRef++; this.refs.set(id, info); return id; }

  // ---------- teardown ----------
  kill() {
    if (this.child && !this.child.killed && this.child.exitCode === null) this.child.kill();
    if (!this.child && !this.finished) {
      // Terminal mode: ask the agent to quit; if it is blocked (e.g. waiting for stdin) kill the process.
      this.write('quit');
      if (this.termPid) {
        const pid = this.termPid;
        setTimeout(() => { try { process.kill(pid); } catch (e) { /* already gone */ } }, 800).unref();
      }
    }
    this.finish(this.exitCode !== null ? this.exitCode : 0);
  }

  finish(code) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.helloTimer);
    this.event('exited', { exitCode: code === null || code === undefined ? 0 : code });
    this.event('terminated');
    this.closeServer();
  }

  closeServer() {
    try { if (this.agent) this.agent.destroy(); } catch (e) { /* ignore */ }
    try { if (this.server) this.server.close(); } catch (e) { /* ignore */ }
  }

  dispose() {
    clearTimeout(this.helloTimer);
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.closeServer();
  }
}

module.exports = { TclDebugAdapter };
