'use strict';

const path = require('path');
const { spawn } = require('child_process');
const scanner = require('./scanner');

const MARKER = '@@TCLTOOLS_TEST@@';

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo, character: offset - starts[lo] };
}

/** Discover literal tcltest `test name description ...` commands. */
function parseTclTests(text) {
  const commands = scanner.scanCommands(text);
  const starts = lineStarts(text);
  const hidden = [];
  const tests = [];
  for (const command of commands) {
    if (hidden.some(([a, b]) => a < command.start && command.start < b)) continue;
    const words = command.words;
    if (words.length < 3 || words[0].type !== 'bare') continue;
    const commandName = text.slice(words[0].start, words[0].end).replace(/^::/, '');
    if (commandName !== 'test' && commandName !== 'tcltest::test') continue;
    const raw = scanner.wordText(text, words[1]);
    if (!raw || ((words[1].type === 'bare' || words[1].type === 'quote') && /[$\[]/.test(raw))) continue;
    const description = scanner.wordText(text, words[2]).replace(/\s+/g, ' ').trim();
    const start = positionAt(starts, words[1].start);
    const end = positionAt(starts, words[1].end);
    tests.push({ name: raw, description, start, end, offset: command.start });
    // A `test` command's braced arguments are scripts/data owned by that test,
    // not additional top-level test declarations.
    for (let i = 2; i < words.length; i++) if (words[i].type === 'brace') hidden.push([words[i].start, words[i].end]);
  }
  return tests;
}

function decodeHex(value) {
  try { return Buffer.from(value, 'hex').toString('utf8'); } catch (e) { return ''; }
}

function markerEvent(line) {
  if (!line.startsWith(MARKER + '\t')) return null;
  const parts = line.split('\t');
  const kind = parts[1];
  if (!['passed', 'failed', 'skipped', 'error'].includes(kind)) return null;
  return { kind, name: decodeHex(parts[2] || ''), duration: Number(parts[3]) || 0, message: decodeHex(parts[4] || '') };
}

/** Parse machine records written to the TCLTOOLS_TEST_EVENTS file (Debug Test). */
function parseEventsText(text) {
  return String(text || '').split(/\r?\n/).map(markerEvent).filter(Boolean);
}

function runTestFile({ exe, args = [], runner, file, names = [], cwd, token, onOutput }) {
  return new Promise(resolve => {
    const events = [];
    let output = '';
    let child;
    try {
      child = spawn(exe, [...args, runner, file, ...names], {
        cwd: cwd || path.dirname(file), windowsHide: true, env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) { resolve({ events, output, error, exitCode: null, cancelled: false }); return; }
    let cancelled = false;
    const disposables = [];
    if (token && token.onCancellationRequested) disposables.push(token.onCancellationRequested(() => {
      cancelled = true;
      if (child.exitCode === null) child.kill();
    }));
    const buffers = { stdout: '', stderr: '' };
    const accept = (which, chunk) => {
      const text = chunk.toString();
      output += text;
      buffers[which] += text;
      const lines = buffers[which].split(/\r?\n/);
      buffers[which] = lines.pop();
      for (const line of lines) {
        const event = markerEvent(line);
        if (event) events.push(event);
        else if (onOutput) onOutput(line + '\n');
      }
    };
    child.stdout.on('data', chunk => accept('stdout', chunk));
    child.stderr.on('data', chunk => accept('stderr', chunk));
    child.on('error', error => { child.__tclError = error; });
    child.on('close', exitCode => {
      for (const which of ['stdout', 'stderr']) {
        if (buffers[which]) {
          const event = markerEvent(buffers[which]);
          if (event) events.push(event);
          else if (onOutput) onOutput(buffers[which]);
        }
      }
      for (const d of disposables) if (d && d.dispose) d.dispose();
      resolve({ events, output, error: child.__tclError, exitCode, cancelled });
    });
  });
}

module.exports = { MARKER, parseTclTests, markerEvent, parseEventsText, runTestFile };
