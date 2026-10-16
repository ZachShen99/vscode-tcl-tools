const vscode = require('vscode');
const path = require('path');
const { activateProviders } = require('./providers');
const { registerDebug } = require('./debug/inline');
const { resolveInterpreter, registerInterpreterSelector } = require('./interpreter');
const { registerTesting } = require('./testing');
const onboarding = require('./onboarding');

let extensionContext;

function runScript(file, cwd, resource) {
  const interpreter = resolveInterpreter(vscode, extensionContext, 'run', resource);
  const term = vscode.window.createTerminal({ name: 'Tcl', shellPath: interpreter.exe, shellArgs: [...interpreter.args, file], cwd });
  term.show(true);
}

async function runFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'tcl') {
    vscode.window.showWarningMessage('Open a Tcl file first.');
    return;
  }
  if (editor.document.isUntitled) {
    vscode.window.showWarningMessage('Save the file before running.');
    return;
  }
  if (!await editor.document.save()) {
    vscode.window.showWarningMessage('Tcl file could not be saved; nothing was run.');
    return;
  }
  runScript(editor.document.fileName, path.dirname(editor.document.fileName), editor.document.uri);
}

async function runSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'tcl') return;
  const sel = editor.selection;
  const text = sel.isEmpty
    ? editor.document.lineAt(sel.active.line).text
    : editor.document.getText(sel);
  if (!text.trim()) return;
  // one private directory per run, so two quick runs never overwrite each other; old ones are swept
  const { createSelectionScript, sweepSelectionScripts } = require('./runselection');
  sweepSelectionScripts();
  const { file } = createSelectionScript(text);
  const cwd = editor.document.isUntitled
    ? (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri.fsPath) || process.cwd()
    : path.dirname(editor.document.fileName);
  runScript(file, cwd, editor.document.uri);
}

function activate(context) {
  extensionContext = context;
  const output = vscode.window.createOutputChannel('Tcl Tools');
  context.subscriptions.push(output);
  const log = msg => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  const providers = activateProviders(context, log);
  registerTesting(context, log);
  registerDebug(context);
  onboarding.register(vscode, context);
  registerInterpreterSelector(vscode, context, () => providers.refreshIntrospection(false));
  context.subscriptions.push(
    vscode.commands.registerCommand('tcl.runFile', runFile),
    vscode.commands.registerCommand('tcl.runSelection', runSelection)
  );
}

function deactivate() {}

module.exports = { activate, deactivate, runFile, runSelection };
