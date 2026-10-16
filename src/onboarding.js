'use strict';
// Getting-started support: the walkthrough command, the sample file and a one-time hint (vscode is passed in so it can be tested).
const fs = require('fs');
const os = require('os');
const path = require('path');

const WALKTHROUGH_ID = 'zach-shen.tcl-tools#tcl-tools.gettingStarted';
const SEEN_KEY = 'tcl.gettingStarted.shown';
const MEDIA = path.join('media', 'walkthrough');

/** 'zh' or 'en': `tcl.docLanguage` when set, otherwise VS Code's display language (the same rule as the command descriptions). */
function uiLanguage(vscode) {
  let pref = 'auto';
  try { pref = vscode.workspace.getConfiguration('tcl').get('docLanguage', 'auto'); } catch (e) { /* default */ }
  if (pref === 'zh' || pref === 'en') return pref;
  return /^zh/i.test((vscode.env && vscode.env.language) || 'en') ? 'zh' : 'en';
}

const TEXT = {
  en: { hint: 'Tcl Tools: new here? A two-minute tour covers the interpreter, running, tests and debugging.', open: 'Open Getting Started', later: 'Not now', sampleError: 'could not open the sample file', guideError: 'could not open the user guide' },
  zh: { hint: 'Tcl Tools：第一次使用？两分钟了解解释器、运行、测试和调试。', open: '打开入门引导', later: '以后再说', sampleError: '无法打开示例文件', guideError: '无法打开使用指南' }
};

/** Copy the sample into the extension's storage (never over an existing copy, so the user's edits survive) and return its path. */
function prepareSample(context, language = 'en') {
  const dir = context.globalStorageUri && context.globalStorageUri.fsPath ? context.globalStorageUri.fsPath : path.join(os.tmpdir(), 'tcl-tools');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, language === 'zh' ? 'tcl-tools-sample.zh.tcl' : 'tcl-tools-sample.tcl');
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(context.extensionPath, MEDIA, language === 'zh' ? 'sample.zh.tcl' : 'sample.tcl'), target);
  return target;
}

function register(vscode, context) {
  const openWalkthrough = () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  const openSample = async () => {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(prepareSample(context, uiLanguage(vscode))));
      await vscode.window.showTextDocument(doc);
    } catch (e) {
      vscode.window.showErrorMessage(`Tcl Tools: ${TEXT[uiLanguage(vscode)].sampleError} (${e.message}).`);
    }
  };
  // The guide ships inside the extension; open it as a rendered Markdown preview in the display language.
  const openGuide = async () => {
    const file = uiLanguage(vscode) === 'zh' ? 'USER_GUIDE.zh-CN.md' : 'USER_GUIDE.md';
    try {
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(context.extensionPath, 'docs', file)));
    } catch (e) {
      vscode.window.showErrorMessage(`Tcl Tools: ${TEXT[uiLanguage(vscode)].guideError} (${e.message}).`);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('tcl.getStarted', openWalkthrough),
    vscode.commands.registerCommand('tcl.openGuide', openGuide),
    vscode.commands.registerCommand('tcl.openWalkthroughSample', openSample)
  );
  // A single, dismissible hint the first time the extension activates; never shown again afterwards.
  const state = context.globalState;
  if (state && !state.get(SEEN_KEY)) {
    state.update(SEEN_KEY, true);
    const text = TEXT[uiLanguage(vscode)];
    Promise.resolve(vscode.window.showInformationMessage(text.hint, text.open, text.later))
      .then(choice => { if (choice === text.open) return openWalkthrough(); return undefined; });
  }
}

module.exports = { register, prepareSample, uiLanguage, TEXT, WALKTHROUGH_ID, SEEN_KEY };
