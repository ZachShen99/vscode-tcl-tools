'use strict';
const vscode = require('vscode');
const { TclDebugAdapter } = require('./adapter');
const { resolveInterpreter } = require('../interpreter');

class InlineAdapter {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this._emitter.event;
    this.adapter = new TclDebugAdapter(msg => this._emitter.fire(msg));
  }
  handleMessage(msg) { this.adapter.handleMessage(msg); }
  dispose() { this.adapter.dispose(); this._emitter.dispose(); }
}

function registerDebug(context) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('tcl', {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new InlineAdapter())
    }),
    vscode.debug.registerDebugConfigurationProvider('tcl', {
      // F5 on a Tcl file without a launch.json
      resolveDebugConfiguration(_folder, config) {
        const editor = vscode.window.activeTextEditor;
        if (!config.type && !config.request && !config.name) {
          if (!editor || editor.document.languageId !== 'tcl') return undefined;
          config.type = 'tcl';
          config.name = 'Debug current Tcl file';
          config.request = 'launch';
          config.program = '${file}';
          config.stopOnEntry = false;
        }
        if (!config.program) {
          vscode.window.showErrorMessage('Tcl debug: "program" is not set in the launch configuration.');
          return undefined;
        }
        const selected = resolveInterpreter(vscode, context, 'debug', editor && editor.document && editor.document.uri);
        const explicitInterpreter = !!config.interpreter;
        if (!config.interpreter) config.interpreter = selected.exe;
        if (!explicitInterpreter && !config.interpreterArgs) config.interpreterArgs = selected.args;
        return config;
      }
    })
  );
}

module.exports = { registerDebug };
