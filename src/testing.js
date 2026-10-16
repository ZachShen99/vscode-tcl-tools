'use strict';

const path = require('path');
const vscode = require('vscode');
const { resolveInterpreter } = require('./interpreter');
const fs = require('fs');
const os = require('os');
const { parseTclTests, parseEventsText, runTestFile } = require('./tcltest');

const CONTROLLER_ID = 'tclTools.tcltest';

function registerTesting(context, log) {
  if (!vscode.tests || !vscode.tests.createTestController) return null;
  const controller = vscode.tests.createTestController(CONTROLLER_ID, 'Tcl Tests');
  const data = new WeakMap();
  const fileItems = new Map();
  let watcher;
  let generation = 0;
  const decoder = new TextDecoder('utf-8');
  const config = resource => vscode.workspace.getConfiguration('tcl.testing', resource);
  const pattern = () => config().get('filePattern', '**/*.test');
  const exclude = () => config().get('exclude', '**/{.git,node_modules,.venv}/**');

  const rangeOf = t => new vscode.Range(t.start.line, t.start.character, t.end.line, t.end.character);
  function updateFile(uri, text) {
    const key = uri.toString();
    const tests = parseTclTests(text);
    let file = fileItems.get(key);
    if (!tests.length) {
      if (file) { controller.items.delete(key); fileItems.delete(key); }
      return;
    }
    if (!file) {
      file = controller.createTestItem(key, path.basename(uri.fsPath || uri.path), uri);
      file.sortText = uri.fsPath || uri.path;
      controller.items.add(file);
      fileItems.set(key, file);
      data.set(file, { kind: 'file', uri });
    }
    const children = tests.map((t, index) => {
      const item = controller.createTestItem(`${key}#${t.offset}`, t.name, uri);
      item.range = rangeOf(t);
      item.description = t.description;
      item.sortText = String(index).padStart(8, '0');
      data.set(item, { kind: 'test', uri, name: t.name, offset: t.offset });
      return item;
    });
    file.children.replace(children);
  }

  async function readFile(uri) {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) { updateFile(uri, open.getText()); return; }
    try { updateFile(uri, decoder.decode(await vscode.workspace.fs.readFile(uri))); }
    catch (error) { log(`test discovery ${uri.fsPath || uri}: ${error.message}`); }
  }

  async function discover() {
    const myGeneration = ++generation;
    if (!config().get('enabled', true)) {
      for (const key of [...fileItems.keys()]) { controller.items.delete(key); fileItems.delete(key); }
      return;
    }
    const files = await vscode.workspace.findFiles(pattern(), exclude());
    if (myGeneration !== generation) return;
    const found = new Set(files.map(u => u.toString()));
    for (const key of [...fileItems.keys()]) if (!found.has(key)) { controller.items.delete(key); fileItems.delete(key); }
    await Promise.all(files.map(readFile));
  }

  function resetWatcher() {
    if (watcher) watcher.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(pattern());
    watcher.onDidCreate(discover);
    watcher.onDidChange(uri => fileItems.has(uri.toString()) ? readFile(uri) : discover());
    watcher.onDidDelete(uri => { const key = uri.toString(); controller.items.delete(key); fileItems.delete(key); });
  }

  const descendants = item => {
    const out = [];
    const visit = x => { const d = data.get(x); if (d && d.kind === 'test') out.push(x); x.children.forEach(visit); };
    visit(item);
    return out;
  };
  function requestedTests(request) {
    const included = request.include ? request.include.flatMap(descendants) : [...fileItems.values()].flatMap(descendants);
    const excluded = new Set((request.exclude || []).flatMap(descendants));
    return [...new Set(included)].filter(item => !excluded.has(item));
  }

  /** Map the records of one test file onto its Test Explorer items. */
  function reportGroup(run, group, result, token) {
    const queues = new Map();
    for (const event of result.events) {
      if (!event.name) continue;
      if (!queues.has(event.name)) queues.set(event.name, []);
      queues.get(event.name).push(event);
    }
    const sourceError = result.events.find(e => e.kind === 'error');
    for (const item of group.items) {
      const d = data.get(item);
      const event = (queues.get(d.name) || []).shift();
      if (event && event.kind === 'passed') run.passed(item, event.duration);
      else if (event && event.kind === 'skipped') run.skipped(item);
      else if (event && event.kind === 'failed') {
        const message = new vscode.TestMessage(event.message || result.output.slice(-8000) || (result.debug ? 'tcltest reported a failure; the expected and actual values are in the Debug Console.' : 'tcltest assertion failed.'));
        message.location = new vscode.Location(item.uri, item.range);
        run.failed(item, message, event.duration);
      } else if (result.cancelled || token.isCancellationRequested) run.skipped(item);
      else if (sourceError || result.error || result.exitCode) {
        const detail = (sourceError && sourceError.message) || (result.error && result.error.message) || result.output.slice(-8000) || `tclsh exited with code ${result.exitCode}`;
        const message = new vscode.TestMessage(detail);
        message.location = new vscode.Location(item.uri, item.range);
        run.errored(item, message);
      } else run.skipped(item);
    }
  }

  let debugCounter = 0;
  /**
   * Run one test file under the Tcl debugger. The runner is the debugged program, so breakpoints in the test file
   * (including its -setup/-body/-cleanup scripts) hit; results come back through an events file because the
   * debug console is for the program's own output.
   */
  async function debugTestFile({ uri, runner, names, interpreter, token }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-debug-test-'));
    const eventsFile = path.join(dir, 'events.txt');
    const id = `${Date.now()}-${++debugCounter}`;
    const configuration = {
      type: 'tcl', request: 'launch', name: `Debug Tcl test: ${path.basename(uri.fsPath)}`,
      program: runner, args: [uri.fsPath, ...names], cwd: path.dirname(uri.fsPath),
      interpreter: interpreter.exe, interpreterArgs: interpreter.args || [],
      env: { TCLTOOLS_TEST_EVENTS: eventsFile }, console: 'internalConsole', stopOnEntry: false,
      __tclTestRun: id
    };
    const mine = s => s && s.configuration && s.configuration.__tclTestRun === id;
    const subs = [];
    let session;
    let cancelled = false;
    try {
      subs.push(vscode.debug.onDidStartDebugSession(s => { if (mine(s)) session = s; }));
      const ended = new Promise(resolve => subs.push(vscode.debug.onDidTerminateDebugSession(s => { if (mine(s)) resolve(); })));
      if (token && token.onCancellationRequested) subs.push(token.onCancellationRequested(() => {
        cancelled = true;
        if (session) vscode.debug.stopDebugging(session);
      }));
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const started = await vscode.debug.startDebugging(folder, configuration);
      if (!started) return { events: [], output: '', error: new Error('The debug session could not be started.'), exitCode: null, cancelled };
      await ended;
      let text = '';
      try { text = fs.readFileSync(eventsFile, 'utf8'); } catch (e) { /* no records: the program never reached the runner */ }
      return { events: parseEventsText(text), output: '', error: undefined, exitCode: 0, cancelled, debug: true };
    } finally {
      for (const d of subs) if (d && d.dispose) d.dispose();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
  }

  async function runHandler(request, token, debug = false) {
    const run = controller.createTestRun(request);
    if (!config().get('enabled', true)) { run.end(); return; }
    const selected = requestedTests(request);
    const grouped = new Map();
    for (const item of selected) {
      run.enqueued(item);
      const d = data.get(item);
      const key = d.uri.toString();
      if (!grouped.has(key)) grouped.set(key, { uri: d.uri, items: [] });
      grouped.get(key).items.push(item);
    }
    const runner = context.asAbsolutePath('src/tcltest_runner.tcl');
    try {
      for (const group of grouped.values()) {
        if (token.isCancellationRequested) break;
        const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === group.uri.toString());
        if (open && open.isDirty && !await open.save()) {
          for (const item of group.items) run.errored(item, new vscode.TestMessage('The test file could not be saved.'));
          continue;
        }
        for (const item of group.items) run.started(item);
        const interpreter = resolveInterpreter(vscode, context, 'run', group.uri);
        const names = [...new Set(group.items.map(item => data.get(item).name))];
        const result = debug
          ? await debugTestFile({ uri: group.uri, runner, names, interpreter, token })
          : await runTestFile({
            exe: interpreter.exe, args: interpreter.args, runner, file: group.uri.fsPath,
            names,
            cwd: path.dirname(group.uri.fsPath), token,
            onOutput: text => run.appendOutput(text.replace(/(?<!\r)\n/g, '\r\n'))
          });
        reportGroup(run, group, result, token);
      }
    } finally { run.end(); }
  }

  controller.resolveHandler = async item => { if (!item) await discover(); else if (item.uri) await readFile(item.uri); };
  controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => runHandler(request, token, false), true);
  if (vscode.TestRunProfileKind.Debug !== undefined) {
    controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => runHandler(request, token, true), false);
  }
  resetWatcher();
  discover();
  const subscriptions = [controller, { dispose: () => { if (watcher) watcher.dispose(); } },
    vscode.workspace.onDidOpenTextDocument(doc => { if (fileItems.has(doc.uri.toString())) updateFile(doc.uri, doc.getText()); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (fileItems.has(e.document.uri.toString())) updateFile(e.document.uri, e.document.getText()); }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tcl.testing')) { resetWatcher(); discover(); }
    })];
  context.subscriptions.push(...subscriptions);
  return { controller, discover, updateFile, runHandler };
}

module.exports = { registerTesting, CONTROLLER_ID };
