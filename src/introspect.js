'use strict';
const { execFile } = require('child_process');
const path = require('path');
const { parseList } = require('./core');

const SCRIPT = path.join(__dirname, 'introspect.tcl');

function parseOutput(out) {
  const r = { commands: [], packages: [], procs: [], errors: [], nsCommands: [] };
  for (const line of out.split(/\r?\n/)) {
    const f = line.split('\t');
    switch (f[0]) {
      case 'C': r.commands.push(f[1]); break;
      case 'K': r.packages.push(f[1]); break;
      case 'N': if (f[1]) r.nsCommands.push(f[1]); break;
      case 'E': r.errors.push({ pkg: f[1], message: f[2] || '' }); break;
      case 'P': {
        const fq = f[1];
        const args = parseList(f[2] || '').map(spec => {
          const p = parseList(spec);
          return p.length > 1 ? { name: p[0], default: p[1] } : { name: p[0] !== undefined ? p[0] : spec };
        });
        r.procs.push({
          name: fq.split('::').pop(), fq, ns: fq.slice(0, fq.lastIndexOf('::')),
          args, doc: '', runtime: true
        });
        break;
      }
      default: break;
    }
  }
  return r;
}

/** Run the interpreter on introspect.tcl and parse its output. */
function runIntrospect({ exe = 'tclsh', args = [], packages = [], timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, [...args, SCRIPT, ...packages],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || '').trim() || err.message));
        resolve(parseOutput(stdout));
      });
  });
}

const TK_SCRIPT = path.join(__dirname, 'introspect_tk.tcl');

function parseTkOutput(out) {
  const r = { version: '', commands: [], widgets: {}, methods: {}, subs: {}, values: {} };
  for (const line of out.split(/\r?\n/)) {
    const f = line.split('\t');
    switch (f[0]) {
      case 'TK': r.version = f[1] || ''; break;
      case 'C': if (f[1]) r.commands.push(f[1]); break;
      case 'W': r.widgets[f[1]] = f.slice(2).filter(Boolean); break;
      case 'M': r.methods[f[1]] = f.slice(2).filter(Boolean); break;
      case 'S': r.subs[f[1]] = f.slice(2).filter(Boolean); break;
      case 'V': r.values[`${f[1]}|${f[2]}`] = f.slice(3).filter(Boolean); break;
      default: break;
    }
  }
  return r.version ? r : null;
}

/** Load Tk once (window withdrawn) and describe its commands, widget options/methods and subcommands. */
function runTkIntrospect({ exe = 'tclsh', args = [], timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, [...args, TK_SCRIPT],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || '').trim() || err.message));
        const r = parseTkOutput(stdout);
        if (!r) return reject(new Error('Tk could not be loaded: ' + (stdout.split('\n').find(l => l.startsWith('E\t')) || stderr || 'unknown').trim()));
        resolve(r);
      });
  });
}

const HANDLE_SCRIPT = path.join(__dirname, 'introspect_handles.tcl');

function parseHandleOutput(out) {
  const r = { types: {}, errors: [] };
  const get = t => (r.types[t] = r.types[t] || { methods: [], values: {} });
  for (const line of out.split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] === 'HM') get(f[1]).methods = f.slice(2).filter(Boolean);
    else if (f[0] === 'HV') get(f[1]).values[f[2]] = f.slice(3).filter(Boolean);
    else if (f[0] === 'HE') r.errors.push({ type: f[1], message: f[2] || '' });
  }
  for (const t of Object.keys(r.types)) if (!r.types[t].methods.length) delete r.types[t];
  return r;
}

/** Create a throw-away object per handle type and ask it for its methods. specs: [{type, package, command, arg}] */
function runHandleIntrospect({ exe = 'tclsh', args = [], specs = [], timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const argv = specs.map(s => `${s.type}=${s.package}=${s.command}=${s.arg || ''}`);
    execFile(exe, [...args, HANDLE_SCRIPT, ...argv],
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || '').trim() || err.message));
        resolve(parseHandleOutput(stdout));
      });
  });
}

module.exports = { runHandleIntrospect, parseHandleOutput, HANDLE_SCRIPT, runIntrospect, parseOutput, SCRIPT, runTkIntrospect, parseTkOutput, TK_SCRIPT };
