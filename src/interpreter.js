'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SELECTED_KEY = 'tcl.selectedInterpreter';

function executablePath(exe) {
  if (path.isAbsolute(exe)) return exe;
  if (exe.includes('/') || exe.includes('\\')) return path.resolve(exe);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const names = process.platform === 'win32' && !/\.exe$/i.test(exe) ? [exe + '.exe', exe] : [exe];
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (e) { /* keep looking */ }
    }
  }
  return exe;
}

function resolveInterpreter(vscode, context, purpose = 'run', resource) {
  const cfg = vscode.workspace.getConfiguration('tcl', resource);
  const selected = context && context.workspaceState && context.workspaceState.get(SELECTED_KEY);
  const selectedExe = typeof selected === 'string' ? selected : selected && selected.exe;
  if (selectedExe) return { exe: selectedExe, args: cfg.get('interpreterArgs', []), source: 'selected' };
  if (purpose !== 'run') {
    const exe = cfg.get('introspection.interpreterPath', '');
    if (exe) return { exe, args: cfg.get('introspection.interpreterArgs', []), source: 'introspection setting' };
  }
  return { exe: cfg.get('interpreterPath', 'tclsh'), args: cfg.get('interpreterArgs', []), source: 'setting' };
}

function probeVersion(exe, timeoutMs = 2000) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { resolve(null); return; }
    let done = false;
    let output = '';
    const finish = version => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(version);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /^([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/m.exec(output);
      if (match) finish(match[1]);
      else if (output.length > 4096) finish(null);
    });
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdin.end('puts [info patchlevel]\nexit\n');
  });
}

async function discoverInterpreters(current) {
  const candidates = new Set([executablePath(current), executablePath('tclsh')]);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of names) {
      if (/^tclsh(?:[0-9.]+)?(?:\.exe)?$/i.test(name)) candidates.add(path.join(dir, name));
    }
  }
  const entries = await Promise.all([...candidates].filter(Boolean).slice(0, 40).map(async exe => ({ exe, version: await probeVersion(exe) })));
  const seen = new Set();
  return entries.filter(e => {
    if (!e.version) return false;
    let canonical;
    try { canonical = fs.realpathSync(e.exe); } catch (err) { canonical = e.exe; }
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  }).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function registerInterpreterSelector(vscode, context, onChange) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'Tcl Interpreter';
  status.command = 'tcl.selectInterpreter';
  const versionCache = new Map();
  let updateId = 0;
  const update = () => {
    const id = ++updateId;
    const editor = vscode.window.activeTextEditor;
    const resource = editor && editor.document.languageId === 'tcl' ? editor.document.uri : undefined;
    const current = resolveInterpreter(vscode, context, 'run', resource);
    const saved = context.workspaceState && context.workspaceState.get(SELECTED_KEY);
    const savedVersion = saved && typeof saved === 'object' && saved.exe === current.exe ? saved.version : null;
    const render = version => {
      status.text = version ? `$(terminal) Tcl ${version}` : `$(terminal) Tcl: ${path.basename(current.exe)}`;
    };
    const cachedVersion = versionCache.get(current.exe);
    render(savedVersion || (typeof cachedVersion === 'string' ? cachedVersion : null));
    status.tooltip = `Interpreter: ${current.exe}\nClick to select a Tcl interpreter`;
    status.show();
    if (savedVersion || vscode.workspace.isTrusted === false) return;
    if (!selectedExeIsTclsh(current.exe)) return;
    if (!versionCache.has(current.exe)) versionCache.set(current.exe, probeVersion(current.exe));
    Promise.resolve(versionCache.get(current.exe)).then(version => {
      versionCache.set(current.exe, version);
      if (id === updateId) render(version);
    });
  };
  const select = async () => {
    const current = resolveInterpreter(vscode, context, 'run');
    const saved = context.workspaceState && context.workspaceState.get(SELECTED_KEY);
    const selectedExe = typeof saved === 'string' ? saved : saved && saved.exe;
    const candidates = await discoverInterpreters(current.exe);
    const items = [
      { label: `${selectedExe ? '' : '$(check) '}Use configured interpreter`, description: vscode.workspace.getConfiguration('tcl').get('interpreterPath', 'tclsh'), value: null },
      ...candidates.map(c => ({ label: `${selectedExe === c.exe ? '$(check) ' : ''}Tcl ${c.version}`, description: c.exe, value: c })),
      { label: 'Enter interpreter path…', value: 'input' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select the Tcl interpreter for run, completion, and debug' });
    if (!picked) return;
    let selected = picked.value;
    if (selected === 'input') {
      const input = await vscode.window.showInputBox({ prompt: 'Path to a plain tclsh executable', value: current.exe });
      if (!input) return;
      const exe = executablePath(input);
      const version = await probeVersion(exe);
      if (!version) { vscode.window.showErrorMessage(`Could not run a Tcl interpreter at "${input}".`); return; }
      selected = { exe, version };
    }
    if (context.workspaceState) await context.workspaceState.update(SELECTED_KEY, selected);
    update();
    await onChange();
  };
  const subscriptions = [status, vscode.commands.registerCommand('tcl.selectInterpreter', select),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tcl.interpreterPath')) update(); })];
  context.subscriptions.push(...subscriptions);
  update();
  return { update, select };
}

function selectedExeIsTclsh(exe) {
  return /^tclsh(?:[0-9.]*)?(?:\.exe)?$/i.test(path.basename(exe));
}

module.exports = { SELECTED_KEY, resolveInterpreter, probeVersion, discoverInterpreters, registerInterpreterSelector };
