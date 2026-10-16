'use strict';
const vscode = require('vscode');
const core = require('./core');
const langfiles = require('./langfiles');
const { runIntrospect, runTkIntrospect, runHandleIntrospect } = require('./introspect');
const { diagnose } = require('./diagnostics');
const { resolveInterpreter, probeVersion } = require('./interpreter');
const { buildReport } = require('./envreport');
const tclSymbols = require('./symbols');
const sourceGraph = require('./sourcegraph');
const undefinedCommands = require('./undefinedcmds');
const projectConfigs = require('./projectconfig');

const SELECTOR = { language: 'tcl' };

class TclIndex {
  constructor(roots = []) {
    this.roots = roots;
    this.files = new Map(); // uri string -> {uri, scan}
    this.ooCache = null;
    this.refCache = null;
    this.truncated = false;
    this.resetRuntime();
  }
  resetRuntime() {
    this.runtime = { commands: new Set(), packages: new Set(), procs: [], loaded: new Set(), nsCommands: new Set() };
    this.runtimeByKey = new Map();
    this.loadedKeys = new Set();
    this.packageErrors = [];
    this.runtimeGeneration = (this.runtimeGeneration || 0) + 1;
  }
  update(uri, text) {
    const scan = core.scanDocument(text);
    this.files.set(uri.toString(), { uri, text, scan, sources: sourceGraph.sourceReferences(text),
      ooClasses: core.oo.parseClasses(text, scan, uri) });
    this.ooCache = null;
    this.refCache = null;
  }
  remove(uri) { this.files.delete(uri.toString()); this.ooCache = null; this.refCache = null; }
  /** Names that appear anywhere in the workspace other than as a command word (see undefinedcmds.js). */
  references() { return this.refCache || (this.refCache = undefinedCommands.workspaceReferences(this.entries())); }
  scanOf(uri) { const f = this.files.get(uri.toString()); return f ? f.scan : null; }
  workspaceProcs() {
    const out = [];
    for (const f of this.files.values()) for (const p of f.scan.procs) out.push({ ...p, uri: f.uri });
    return out;
  }
  procDefinitions(originUri) {
    const all = this.workspaceProcs();
    if (!originUri) return all;
    const distances = sourceGraph.dependencyDistances(originUri, this.entries(), this.roots);
    const groups = new Map();
    for (const proc of all) {
      if (!groups.has(proc.fq)) groups.set(proc.fq, []);
      groups.get(proc.fq).push(proc);
    }
    const selected = [];
    for (const procs of groups.values()) {
      const reachable = procs.filter(proc => distances.has(proc.uri.toString()));
      if (!reachable.length) { selected.push(...procs); continue; }
      const nearest = Math.min(...reachable.map(proc => distances.get(proc.uri.toString())));
      selected.push(...reachable.filter(proc => distances.get(proc.uri.toString()) === nearest));
    }
    return selected.sort((a, b) => (distances.get(a.uri.toString()) ?? Infinity) - (distances.get(b.uri.toString()) ?? Infinity));
  }
  entries() { return [...this.files.values()]; }
  workspaceOOClasses() {
    if (!this.ooCache) this.ooCache = core.oo.mergeClasses(this.entries().map(entry => entry.ooClasses || new Map()));
    return this.ooCache;
  }
  mergeRuntime(r, key = '') {
    const old = this.runtimeByKey.get(key);
    this.runtimeByKey.set(key, old ? {
      commands: [...new Set([...old.commands, ...r.commands])],
      packages: [...new Set([...old.packages, ...r.packages])],
      loaded: [...new Set([...(old.loaded || []), ...(r.loaded || [])])],
      nsCommands: [...new Set([...(old.nsCommands || []), ...(r.nsCommands || [])])],
      procs: [...new Map([...old.procs, ...r.procs].map(p => [p.fq, p])).values()]
    } : r);
    r.commands.forEach(c => this.runtime.commands.add(c));
    r.packages.forEach(p => this.runtime.packages.add(p));
    (r.loaded || []).forEach(p => this.runtime.loaded.add(p));
    (r.nsCommands || []).forEach(c => this.runtime.nsCommands.add(c));
    const seen = new Set(this.runtime.procs.map(p => p.fq));
    for (const p of r.procs) if (!seen.has(p.fq)) this.runtime.procs.push(p);
  }
  runtimeFor(packages = []) {
    const key = [...new Set(packages)].sort().join(',');
    const out = { commands: new Set(), packages: new Set(), procs: [], loaded: new Set(), nsCommands: new Set() };
    const seen = new Set();
    for (const r of [this.runtimeByKey.get(''), key && this.runtimeByKey.get(key)]) {
      if (!r) continue;
      for (const c of r.commands) out.commands.add(c);
      for (const p of r.packages) out.packages.add(p);
      for (const p of r.loaded || []) out.loaded.add(p);
      for (const c of r.nsCommands || []) out.nsCommands.add(c);
      for (const p of r.procs) if (!seen.has(p.fq)) { seen.add(p.fq); out.procs.push(p); }
    }
    return out;
  }
}

function md(...parts) {
  const s = new vscode.MarkdownString(parts.filter(Boolean).join('\n\n'));
  return s;
}

// Completion items already show the signature as their `detail`, so their documentation is the text only.
function docMarkdown(doc) {
  return doc ? md(doc) : undefined;
}

function sigMarkdown(sig, doc) {
  return md('```tcl\n' + sig + '\n```', doc);
}

function activateProviders(context, log) {
  const index = new TclIndex((vscode.workspace.workspaceFolders || []).map(folder => folder.uri));
  const cfg = () => vscode.workspace.getConfiguration('tcl');
  let warned = false;

  // ----- indexing -----
  const timers = new Map();
  const decoder = new TextDecoder('utf-8');

  // tell VS Code to re-request semantic tokens when the proc index changes (debounced)
  const semanticChanged = new vscode.EventEmitter();
  let semanticTimer;
  const refreshSemantic = () => {
    clearTimeout(semanticTimer);
    semanticTimer = setTimeout(() => semanticChanged.fire(), 200);
  };

  let limitWarned = false;
  const openUris = () => new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
  /** (Re)read a file from disk into the index, unless it is open (open documents are indexed from the editor). */
  async function indexFile(uri) {
    if (openUris().has(uri.toString())) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      index.update(uri, decoder.decode(bytes));
    } catch (e) { log(`index ${uri.fsPath || uri}: ${e.message}`); }
  }

  async function indexWorkspace() {
    const files = await vscode.workspace.findFiles(langfiles.GLOB, langfiles.EXCLUDE, langfiles.MAX_FILES);
    for (const uri of files) await indexFile(uri);
    if (files.length >= langfiles.MAX_FILES) {
      index.truncated = true;
      log(`workspace index is incomplete: only the first ${langfiles.MAX_FILES} files were read`);
      if (!limitWarned) {
        limitWarned = true;
        vscode.window.showWarningMessage(`Tcl Tools: the workspace has more than ${langfiles.MAX_FILES} Tcl files; cross-file completion and go-to-definition only know the first ${langfiles.MAX_FILES}.`);
      }
    }
    refreshSemantic();
    refreshWorkspaceDiagnostics();
  }

  const diagnostics = vscode.languages.createDiagnosticCollection('tcl');
  // Undefined-command warnings need real interpreter data and a plain tclsh/wish; host tools (Vivado ...) and
  // constraint files define commands we cannot see.
  const PLAIN_INTERPRETER = /^(tclsh|wish)[\d.]*(\.exe)?$/i;
  /** {checker} when the undefined-command check runs for this document, otherwise {reason}. */
  function undefinedStatus(doc, scan) {
    const config = cfg();
    if (config.get('diagnostics.enabled', true) === false) return { reason: 'tcl.diagnostics.enabled is off' };
    if (config.get('diagnostics.undefinedCommands', 'warning') === 'off') return { reason: 'tcl.diagnostics.undefinedCommands is "off"' };
    const resolved = resolveFor(doc);
    if (resolved.checkOff.length && !resolved.check) return { reason: `the file matches host "${resolved.checkOff.join('", "')}" in the project config, which does not enable checking (set "check": true on it)` };
    if (!resolved.check && /\.(xdc|sdc)$/i.test(doc.uri.path || doc.uri.fsPath || '')) return { reason: '.xdc/.sdc files use host-tool commands the extension cannot see (describe the host in the project config with "check": true to check them)' };
    // A host file opted in to checking is judged by the interpreter used for introspection, not the one that runs it.
    const exe = resolveInterpreter(vscode, context, resolved.check ? 'introspection' : 'run', doc.uri).exe || '';
    const base = exe.replace(/^.*[\\/]/, '');
    if (!PLAIN_INTERPRETER.test(base)) return { reason: `the interpreter "${base || '(none)'}" is not a plain tclsh/wish; host tools define commands the extension cannot see${resolved.check ? ' (set tcl.introspection.interpreterPath to a plain tclsh)' : ''}` };
    if (vscode.workspace.isTrusted === false) return { reason: 'the workspace is not trusted (introspection runs the interpreter)' };
    if (!config.get('introspection.enabled', true)) return { reason: 'tcl.introspection.enabled is false (the check needs the interpreter\'s command list)' };
    const runtime = index.runtimeFor(scan ? scan.packages : []);
    const known = new Set([...Object.keys(core.builtins.commands), ...Object.keys(core.builtins.ensembles), ...core.stdCommandNames()]);
    const options = {
      uri: doc.uri, entries: index.entries(), roots: index.roots, runtime, known,
      references: index.references(), extra: [...config.get('diagnostics.knownCommands', []), ...projectConfigs.acceptedNames(resolved)],
      procNames: index.workspaceProcs().map(p => p.name), complete: !index.truncated
    };
    const checker = undefinedCommands.createChecker(options);
    return checker ? { checker } : { reason: undefinedCommands.explain(options) || 'unknown reason' };
  }
  const undefinedChecker = (doc, scan) => undefinedStatus(doc, scan).checker || null;
  function refreshDiagnostics(doc) {
    if (doc.languageId !== 'tcl') return;
    if (!cfg().get('diagnostics.enabled', true)) { diagnostics.delete(doc.uri); return; }
    const text = doc.getText();
    const scan = index.scanOf(doc.uri) || core.scanDocument(text);
    diagnostics.set(doc.uri, diagnose(text, { scan, definitions: index.procDefinitions(doc.uri), undefinedCommands: undefinedChecker(doc, scan) }).map(d => {
      const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
      const diag = new vscode.Diagnostic(range, d.message,
        d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      diag.source = 'Tcl Tools';
      diag.code = d.code;
      return diag;
    }));
  }
  let diagnosticsTimer;
  const refreshWorkspaceDiagnostics = () => {
    clearTimeout(diagnosticsTimer);
    diagnosticsTimer = setTimeout(() => vscode.workspace.textDocuments.forEach(refreshDiagnostics), 200);
  };


  // ----- project configuration (.tcl-tools.json) -----
  let projectConfig = projectConfigs.merge([]);
  let projectState = { files: [], problems: [] };
  const projectProcsMemo = new Map();
  const docRelativePath = doc => (vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(doc.uri, false) : (doc.uri.fsPath || doc.uri.path || ''));
  const resolveFor = doc => projectConfigs.resolve(projectConfig, docRelativePath(doc));
  const configDiagnostics = vscode.languages.createDiagnosticCollection('tcl-tools-config');
  const configDiagUris = new Map();
  /** Commands from the project config that apply to this document (global ones plus matching hosts). */
  const projectProcsFor = doc => {
    const resolved = resolveFor(doc);
    const lang = core.docLanguage();
    const key = `${lang}|${resolved.hosts.join(',')}`;
    let procs = projectProcsMemo.get(key);
    if (!procs) { procs = projectConfigs.toProcs(resolved, lang); projectProcsMemo.set(key, procs); }
    return procs;
  };
  async function loadProjectConfig() {
    const parsed = [];
    const files = [];
    const problems = [];
    const seen = new Set();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const location of projectConfigs.LOCATIONS) {
        let uri;
        try { uri = vscode.Uri.joinPath(folder.uri, ...location.split('/')); } catch (e) { continue; }
        let text;
        try { text = decoder.decode(await vscode.workspace.fs.readFile(uri)); } catch (e) { continue; }   // no file: fine
        if (!text.trim()) continue;
        const result = projectConfigs.parse(text);
        parsed.push(result);
        files.push(uri.fsPath || uri.toString());
        seen.add(uri.toString());
        const diags = [...result.errors.map(m => [m, vscode.DiagnosticSeverity.Error]), ...result.warnings.map(m => [m, vscode.DiagnosticSeverity.Warning])]
          .map(([message, severity]) => { const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, severity); d.source = 'Tcl Tools'; return d; });
        configDiagnostics.set(uri, diags);
        configDiagUris.set(uri.toString(), uri);
        problems.push(...result.errors, ...result.warnings);
        for (const m of result.errors) log(`${location}: ${m}`);
      }
    }
    for (const [key, uri] of configDiagUris) if (!seen.has(key)) { configDiagnostics.delete(uri); configDiagUris.delete(key); }
    projectConfig = projectConfigs.merge(parsed);
    projectProcsMemo.clear();
    projectState = { files, problems };
    if (files.length) log(`project config: ${Object.keys(projectConfig.commands).length} commands, ${projectConfig.knownCommands.length} known-command patterns, ${Object.keys(projectConfig.hosts).length} hosts`);
    refreshSemantic();
    refreshWorkspaceDiagnostics();
  }

  function indexDocument(doc) {
    if (doc.languageId !== 'tcl') return;
    index.update(doc.uri, doc.getText());
    refreshSemantic();
    refreshDiagnostics(doc);
    refreshWorkspaceDiagnostics();
    ensureRuntimeFor(doc);
  }

  // ----- runtime introspection -----
  async function ensureRuntime(packages) {
    if (!cfg().get('introspection.enabled', true) || vscode.workspace.isTrusted === false) return;
    const pkgs = [...new Set(packages)].sort();
    const key = pkgs.join(',');
    if (index.loadedKeys.has(key)) return;
    index.loadedKeys.add(key);
    const generation = index.runtimeGeneration;
    try {
      const interpreter = resolveInterpreter(vscode, context, 'introspection');
      const r = await runIntrospect({ exe: interpreter.exe, args: interpreter.args, packages: pkgs });
      r.loaded = pkgs.filter(pk => !r.errors.some(e => e.pkg === pk));
      if (generation !== index.runtimeGeneration) return;
      index.mergeRuntime(r, key);
      refreshSemantic();
      refreshWorkspaceDiagnostics();
      r.errors.forEach(e => {
        log(`package require ${e.pkg} failed: ${e.message}`);
        if (!index.packageErrors.some(x => x.pkg === e.pkg)) index.packageErrors.push({ pkg: e.pkg, message: e.message });
      });
      log(`introspection [${key || 'baseline'}]: ${r.commands.length} commands, ${r.procs.length} package procs`);
    } catch (e) {
      if (generation !== index.runtimeGeneration) return;
      index.loadedKeys.delete(key);
      log(`introspection failed: ${e.message}`);
      if (!warned) {
        warned = true;
        vscode.window.showWarningMessage(
          `Tcl Tools: could not run "${resolveInterpreter(vscode, context, 'introspection').exe}" for introspection ` +
          `(${e.message}). Select a plain tclsh, or disable tcl.introspection.enabled.`);
      }
    }
  }
  // Tk is described by the installed Tk itself (loaded once, window withdrawn) and cached.
  let tkState = 'idle';
  async function ensureTkRuntime() {
    if (tkState !== 'idle' || !cfg().get('introspection.enabled', true) || !cfg().get('introspection.tk', true) || vscode.workspace.isTrusted === false) return;
    tkState = 'loading';
    const generation = index.runtimeGeneration;
    const { exe, args } = resolveInterpreter(vscode, context, 'introspection');
    const key = `${exe}|${args.join(' ')}`;
    const store = context.globalState;
    try {
      const cached = store && store.get('tcl.tkIntrospection');
      if (cached && cached.key === key && cached.schema === 1) {
        if (generation !== index.runtimeGeneration) return;
        core.setTkRuntime(cached.data);
        tkState = 'done';
        log(`Tk introspection (cached): Tk ${cached.data.version}, ${Object.keys(cached.data.widgets).length} widget classes`);
        return;
      }
      const data = await runTkIntrospect({ exe, args });
      if (generation !== index.runtimeGeneration) return;
      core.setTkRuntime(data);
      if (store) store.update('tcl.tkIntrospection', { key, schema: 1, data });
      tkState = 'done';
      log(`Tk introspection: Tk ${data.version}, ${Object.keys(data.widgets).length} widget classes`);
    } catch (e) {
      if (generation !== index.runtimeGeneration) return;
      tkState = 'failed';
      log(`Tk introspection unavailable (${e.message}); using the built-in Tk tables.`);
    }
  }
  // Handle objects (sqlite3 ...) are described by creating a throw-away one and asking for its methods.
  const handleState = {};
  async function ensureHandleRuntime(specs) {
    if (!cfg().get('introspection.enabled', true) || vscode.workspace.isTrusted === false) return;
    const todo = specs.filter(s => !handleState[s.type]);
    if (!todo.length) return;
    for (const s of todo) handleState[s.type] = 'loading';
    const generation = index.runtimeGeneration;
    const { exe, args } = resolveInterpreter(vscode, context, 'introspection');
    const key = `${exe}|${args.join(' ')}`;
    const store = context.globalState;
    try {
      const all = (store && store.get('tcl.handleIntrospection')) || {};
      const merged = { types: {} };
      const need = [];
      for (const s of todo) {
        const c = all[s.type];
        if (c && c.key === key && c.schema === 1) merged.types[s.type] = c.data; else need.push(s);
      }
      if (need.length) {
        const r = await runHandleIntrospect({ exe, args, specs: need });
        if (generation !== index.runtimeGeneration) return;
        for (const s of need) {
          if (r.types[s.type]) { merged.types[s.type] = r.types[s.type]; all[s.type] = { key, schema: 1, data: r.types[s.type] }; }
          else log(`Handle introspection for ${s.type}: ${(r.errors.find(e => e.type === s.type) || {}).message || 'no methods reported'}; using built-in table.`);
        }
        if (store) store.update('tcl.handleIntrospection', all);
      }
      const current = core.handleRuntimeData ? core.handleRuntimeData() : null;
      core.setHandleRuntime({ types: { ...((current && current.types) || {}), ...merged.types } });
      for (const s of todo) handleState[s.type] = 'done';
      log(`Handle introspection: ${Object.keys(merged.types).join(', ') || 'none'}`);
    } catch (e) {
      if (generation !== index.runtimeGeneration) return;
      for (const s of todo) handleState[s.type] = 'failed';
      log(`Handle introspection unavailable (${e.message}); using the built-in tables.`);
    }
  }
  function ensureRuntimeFor(doc) {
    if (core.usesTk(doc.getText())) ensureTkRuntime();
    const hs = core.handleSpecs(doc.getText());
    if (hs.length) ensureHandleRuntime(hs);
    const scan = index.scanOf(doc.uri);
    return ensureRuntime(scan ? scan.packages : []);
  }

  const currentEntry = doc => {
    let entry = index.files.get(doc.uri.toString());
    const text = doc.getText();
    if (!entry || entry.text !== text) { index.update(doc.uri, text); entry = index.files.get(doc.uri.toString()); }
    return entry;
  };
  const allProcLists = doc => {
    const local = currentEntry(doc).scan;
    const runtime = index.runtimeFor(local ? local.packages : []);
    return [local ? local.procs : [], index.procDefinitions(doc.uri), core.bundledProcs(local ? local.packages : [], doc.getText(), runtime), runtime.procs, projectProcsFor(doc)];
  };
  const procDefs = docOrUri => index.procDefinitions(docOrUri && docOrUri.uri ? docOrUri.uri : docOrUri);

  // Language of the built-in command descriptions: "auto" follows VS Code's display language.
  function applyDocLanguage() {
    const pref = cfg().get('docLanguage', 'auto');
    const ui = (vscode.env && vscode.env.language) || 'en';
    core.setDocLanguage(pref === 'zh' || (pref === 'auto' && /^zh/i.test(ui)) ? 'zh' : 'en');
  }
  applyDocLanguage();
  core.setEnvNames(Object.keys(process.env));

  // ----- completion -----
  const completion = {
    provideCompletionItems(doc, pos, _token, ctx) {
      const offset = doc.offsetAt(pos);
      const source = sourceGraph.sourceContext(doc.getText(), offset);
      if (source && source.value !== null) {
        const range = new vscode.Range(doc.positionAt(source.start), pos);
        return sourceGraph.completionCandidates(doc.uri, source.typed, index.entries(), index.roots).map(candidate => {
          const item = new vscode.CompletionItem(candidate.value, vscode.CompletionItemKind.File);
          item.detail = 'Tcl source file';
          item.insertText = candidate.value;
          item.range = range;
          return item;
        });
      }
      const scan = currentEntry(doc).scan;
      const runtime = index.runtimeFor(scan ? scan.packages : []);
      const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
      const a = core.analyzeLinePrefix(prefix);
      const items = [];
      const typedSpace = ctx && ctx.triggerCharacter === ' ';
      const mk = (label, kind, detail, documentation) => {
        // No explicit range: VS Code replaces/filters on the word at the cursor, using the
        // language's wordPattern (which already includes ':' for namespace-qualified names).
        const it = new vscode.CompletionItem(label, kind);
        it.filterText = label;
        if (detail) it.detail = detail;
        if (documentation) it.documentation = documentation;
        return it;
      };

      if (a.kind === 'none') {
        const text = doc.getText();
        const before = text.slice(0, doc.offsetAt(pos));
        const tc = core.handleCompletion(prefix, text) || core.tkCompletion(prefix, text) || core.cmdOptionCompletion(prefix) ||
          core.ooCompletion(prefix, before, index.workspaceOOClasses(), scan) || core.stdCompletion(prefix);
        if (tc) {
          const kind = { options: vscode.CompletionItemKind.Property, values: vscode.CompletionItemKind.EnumMember,
            methods: vscode.CompletionItemKind.Method, events: vscode.CompletionItemKind.Event,
            functions: vscode.CompletionItemKind.Function }[tc.kind];
          const range = new vscode.Range(pos.line, pos.character - tc.typing.length, pos.line, pos.character);
          return tc.items.map(i => {
            const it = mk(i.label, kind, i.detail);
            it.range = range;
            if (tc.kind === 'options' && core.optionDoc(i.label)) it.documentation = md(core.optionDoc(i.label));
            if (i.doc) it.documentation = md(i.doc);
            if (i.insert) it.insertText = i.insert;
            return it;
          });
        }
        return items;
      }
      if (a.kind === 'variable') {
        // Give VS Code an explicit range after `$` / `${`. Relying on the
        // editor's inferred word range can make linked namespace variables
        // disappear from the suggestion widget even though we returned them.
        const variableRange = new vscode.Range(pos.line, pos.character - (a.word || '').length, pos.line, pos.character);
        const addVariable = (name, detail, documentation) => {
          const it = mk(name, vscode.CompletionItemKind.Variable, detail, documentation);
          it.range = variableRange;
          items.push(it);
        };
        const visible = new Set(tclSymbols.visibleVariables(doc.getText(), scan, doc.offsetAt(pos)));
        for (const v of visible) addVariable(v);
        for (const v of Object.keys(core.stdlib.vars)) {
          if (visible.has(v)) continue;
          const d = core.varDoc(v);
          addVariable(v, 'predefined', d ? md(d) : undefined);
        }
      } else if (a.kind === 'package') {
        for (const p of runtime.packages) items.push(mk(p, vscode.CompletionItemKind.Module));
      } else if (a.kind === 'subcommand') {
        const subs = core.builtins.ensembles[a.cmd] || {};
        for (const name of Object.keys(subs)) {
          const e = core.builtinEntry(a.cmd, name);
          items.push(mk(name, vscode.CompletionItemKind.Method, e.sig, docMarkdown(e.doc)));
        }
      } else if (a.kind === 'command' && !typedSpace) {
        const seen = new Set();
        const add = (label, kind, detail, docs) => {
          if (seen.has(label)) return null;
          seen.add(label);
          const it = mk(label, kind, detail, docs);
          items.push(it);
          return it;
        };
        for (const oi of core.ooCommandItems(doc.getText().slice(0, doc.offsetAt(pos)))) add(oi.label, vscode.CompletionItemKind.Keyword, oi.detail, docMarkdown(oi.doc));
        const lists = allProcLists(doc);
        // Namespaced procs: at top level offer the namespace ("http::") only; members appear once the
        // user has typed "http::" (and sub-namespaces are collapsed the same way).
        const word = a.word || '';
        const absolute = word.startsWith('::');
        const bare = word.replace(/^::/, '');
        const nsPrefix = bare.includes('::') ? bare.slice(0, bare.lastIndexOf('::') + 2) : '';
        const lead = absolute ? '::' : '';
        const currentNs = tclSymbols.namespaceAt(scan || { namespaces: [] }, doc.offsetAt(pos));
        lists.forEach((list, li) => {
          for (const p of list) {
            const s = core.procSignature(p);
            const docs = docMarkdown(s.doc);
            if (!p.ns) {
              if (!nsPrefix) add(p.name, vscode.CompletionItemKind.Function, s.label, docs);
              continue;
            }
            const fq = p.fq.replace(/^::/, '');
            if (!fq.startsWith(nsPrefix)) continue;
            const rest = fq.slice(nsPrefix.length);
            const cut = rest.indexOf('::');
            if (cut >= 0) {
              const nsItem = add(lead + nsPrefix + rest.slice(0, cut + 2), vscode.CompletionItemKind.Module, 'namespace');
              if (nsItem) nsItem.command = { command: 'editor.action.triggerSuggest', title: 'Show members' };
            } else {
              add(lead + fq, vscode.CompletionItemKind.Function, s.label, docs);
            }
            if (!nsPrefix && (p.ns === currentNs || p.ns === '')) add(p.name, vscode.CompletionItemKind.Function, s.label, docs);
          }
        });
        if (/^(::)?tcl::/.test(word) && nsPrefix) {
          for (const n of core.stdCommandNames()) {
            const e = core.builtinEntry(n, null);
            add(lead + n, vscode.CompletionItemKind.Function, e.sig, docMarkdown(e.doc));
          }
        }
        if (!nsPrefix) {
          const tkOn = core.usesTk(doc.getText());
          for (const name of new Set([...Object.keys(core.builtins.commands), ...core.ensembleNames])) {
            if (!tkOn && core.tkNames.has(name)) continue;
            const e = core.builtinEntry(name, null);
            add(name, vscode.CompletionItemKind.Function, e.sig, docMarkdown(e.doc));
          }
          for (const c of runtime.commands) if ((tkOn || !core.tkNames.has(c)) && !core.isInternalCommand(c)) add(c, vscode.CompletionItemKind.Function);
        }
      }
      return items;
    }
  };

  // ----- signature help -----
  const signature = {
    provideSignatureHelp(doc, pos) {
      const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
      const ctx = core.callContext(prefix);
      const entry = currentEntry(doc);
      const target = ctx && tclSymbols.resolveProc(ctx.cmd, entry.scan, doc.offsetAt(pos), procDefs(doc));
      const workspaceMatches = ctx ? core.findProcs(ctx.cmd, [procDefs(doc)]) : [];
      const lists = target ? [[target]] : (workspaceMatches.length ? [] : allProcLists(doc));
      const handleSig = core.handleSignature(ctx, doc.getText());
      const ooSig = core.ooSignature(prefix, doc.getText().slice(0, doc.offsetAt(pos)));
      const sig = handleSig || ooSig || (workspaceMatches.length && !target ? null : core.signatureFor(ctx, lists));
      if (!sig) return null;
      const oh = core.optionHelp(prefix, doc.getText());
      const optionParts = [];
      if (oh && oh.option) optionParts.push(`**${oh.option.sig}**: ${oh.option.doc}`);
      if (oh && oh.remaining.length) optionParts.push('Options: ' + oh.remaining.slice(0, 14).join(' ') + (oh.remaining.length > 14 ? ' ...' : ''));
      const info = new vscode.SignatureInformation(sig.label, md(...optionParts, sig.doc));
      info.parameters = sig.params.map(p => new vscode.ParameterInformation(p));
      const help = new vscode.SignatureHelp();
      help.signatures = [info];
      help.activeSignature = 0;
      help.activeParameter = sig.activeParameter;
      return help;
    }
  };

  // ----- hover -----
  const hover = {
    provideHover(doc, pos) {
      const optRange = doc.getWordRangeAtPosition(pos, /-[A-Za-z]\w*/);
      if (optRange) {
        const od = core.tkOptionDoc(doc.lineAt(pos.line).text.slice(0, optRange.start.character), doc.getText(optRange), doc.getText());
        const co = od || core.cmdOptionDoc(doc.lineAt(pos.line).text.slice(0, optRange.start.character), doc.getText(optRange));
        if (co) return new vscode.Hover(sigMarkdown(co.sig, co.doc), optRange);
      }
      const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
      if (!range) return null;
      const word = doc.getText(range);
      if (core.tkNames.has(word) && !core.usesTk(doc.getText())) return null; // `label`, `text` ... are ordinary words outside Tk files
      const before = doc.lineAt(pos.line).text.slice(0, range.start.character);
      const lineText = doc.lineAt(pos.line).text;
      if (/\$\{?$/.test(before) && core.varDoc(word)) return new vscode.Hover(sigMarkdown('$' + word, core.varDoc(word)), range);
      if (lineText[range.end.character] === '(' && core.mathFuncDoc(word) && core.inExprContext(before)) {
        const mf = core.mathFuncDoc(word);
        return new vscode.Hover(sigMarkdown(mf.sig, mf.doc), range);
      }
      const tmd = core.tkMethodDoc(before, word, doc.getText());
      if (tmd) return new vscode.Hover(sigMarkdown(tmd.sig, tmd.doc), range);
      const hd = core.handleDoc(before, word, doc.getText());
      if (hd) return new vscode.Hover(sigMarkdown(hd.sig, hd.doc), range);
      const ood = core.ooWordInfo(word, doc.getText().slice(0, doc.offsetAt(range.end)));
      if (ood) return new vscode.Hover(sigMarkdown(ood.sig, ood.doc), range);
      const m = /(\w+)\s+$/.exec(before);
      if (m && core.builtins.ensembles[m[1]] && core.builtins.ensembles[m[1]][word]) {
        const e = core.builtinEntry(m[1], word);
        if (e) {
          const so = core.optionSummary(m[1], word);
          return new vscode.Hover(sigMarkdown(e.sig, [e.doc, so.length ? 'Options: ' + so.join(' ') : ''].filter(Boolean).join('\n\n')), range);
        }
      }
      const entry = currentEntry(doc);
      const offset = doc.offsetAt(range.start);
      const at = tclSymbols.symbolAt(entry.text, entry.scan, offset);
      const target = at && at.kind === 'proc' && (at.definition || !at.declaration)
        ? (at.definition ? procDefs(doc).find(p => p.uri.toString() === doc.uri.toString() && p.startIdx === at.definition.startIdx)
          : tclSymbols.resolveProc(at.name, entry.scan, at.start, procDefs(doc)))
        : null;
      const workspaceMatches = core.findProcs(word, [procDefs(doc)]);
      const procs = target ? [target] : (workspaceMatches.length ? [] : core.findProcs(word, allProcLists(doc)));
      if (procs.length) {
        const s = core.procSignature(procs[0]);
        const po = core.optionSummary(word);
        return new vscode.Hover(sigMarkdown(s.label, [s.doc, po.length ? 'Options: ' + po.join(' ') : ''].filter(Boolean).join('\n\n')), range);
      }
      const e = core.builtinEntry(word, null);
      if (e) {
        const bo = core.optionSummary(word);
        return new vscode.Hover(sigMarkdown(e.sig, [e.doc, bo.length ? 'Options: ' + bo.join(' ') : ''].filter(Boolean).join('\n\n')), range);
      }
      return null;
    }
  };

  // ----- definition, references, rename & symbols -----
  const positionAt = (text, offset) => {
    let line = 0, last = 0;
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) { line++; last = i + 1; }
    return new vscode.Position(line, offset - last);
  };
  const rangeAt = (text, start, end) => {
    const a = positionAt(text, start), b = positionAt(text, end);
    return new vscode.Range(a.line, a.character, b.line, b.character);
  };
  const resolveAt = (doc, pos) => {
    const entry = currentEntry(doc);
    const offset = doc.offsetAt(pos);
    let symbol = tclSymbols.symbolAt(entry.text, entry.scan, offset);
    // The editor event that refreshes the index is debounced. Resolve the word
    // under the cursor as a literal proc call during that short window too.
    if (!symbol) {
      const range = doc.getWordRangeAtPosition(pos, /[\w:]+/);
      if (range) symbol = { kind: 'proc', name: doc.getText(range), start: offset - (pos.character - range.start.character), end: offset + (range.end.character - pos.character), declaration: false };
    }
    if (!symbol) return null;
    if (symbol.kind === 'proc') {
      const target = symbol.definition
        ? procDefs(doc).find(p => p.uri.toString() === doc.uri.toString() && p.startIdx === symbol.definition.startIdx)
        : tclSymbols.resolveProc(symbol.name, entry.scan, symbol.start, procDefs(doc));
      return target ? { kind: 'proc', symbol, target } : null;
    }
    return { kind: 'variable', symbol, target: symbol.key };
  };
  const locationsFor = (resolved, includeDeclaration) => {
    const hits = [];
    if (resolved.kind === 'proc') {
      for (const entry of index.entries()) {
        for (const call of tclSymbols.procCalls(entry.text, entry.scan)) {
          const target = tclSymbols.resolveProc(call.name, entry.scan, call.start, procDefs(entry.uri));
          if (target && target.uri.toString() === resolved.target.uri.toString() && target.startIdx === resolved.target.startIdx) {
            hits.push({ uri: entry.uri, text: entry.text, start: call.start, end: call.end, declaration: false });
          }
        }
      }
      if (includeDeclaration) {
        const entry = index.files.get(resolved.target.uri.toString());
        if (entry) hits.unshift({ uri: entry.uri, text: entry.text, start: resolved.target.nameStart, end: resolved.target.nameEnd, declaration: true });
      }
    } else {
      const local = resolved.target.startsWith('local:');
      for (const entry of index.entries()) {
        if (local && entry.uri.toString() !== resolved.symbolUri) continue;
        for (const v of tclSymbols.variableSymbols(entry.text, entry.scan)) {
          if (v.key === resolved.target && (includeDeclaration || !v.declaration)) hits.push({ uri: entry.uri, text: entry.text, ...v });
        }
      }
    }
    return hits;
  };

  const definition = {
    provideDefinition(doc, pos) {
      const entry = currentEntry(doc);
      const source = sourceGraph.sourceReferenceAt(entry.text, doc.offsetAt(pos));
      const sourceTarget = source && source.value !== null ? sourceGraph.resolveReference(doc.uri, source, index.entries(), index.roots) : null;
      if (sourceTarget) return [new vscode.Location(sourceTarget.uri, new vscode.Position(0, 0))];
      const ooDefinitions = core.oo.definitionAt(entry.text, entry.scan, entry.ooClasses, index.workspaceOOClasses(), doc.offsetAt(pos));
      if (ooDefinitions.length) return ooDefinitions.map(target => {
        const targetEntry = target.uri && index.files.get(target.uri.toString());
        return targetEntry ? new vscode.Location(target.uri, rangeAt(targetEntry.text, target.start, target.end)) : null;
      }).filter(Boolean);
      const resolved = resolveAt(doc, pos);
      if (!resolved) return null;
      if (resolved.kind === 'proc') {
        const entry = index.files.get(resolved.target.uri.toString());
        return entry ? [new vscode.Location(entry.uri, rangeAt(entry.text, resolved.target.nameStart, resolved.target.nameEnd))] : null;
      }
      resolved.symbolUri = doc.uri.toString();
      const declarations = locationsFor(resolved, true).filter(h => h.declaration);
      if (!declarations.length) return null;
      const sameFile = declarations.filter(h => h.uri.toString() === doc.uri.toString() && h.start <= resolved.symbol.start);
      const chosen = (sameFile.length ? sameFile : declarations).sort((a, b) => b.start - a.start)[0];
      return [new vscode.Location(chosen.uri, rangeAt(chosen.text, chosen.start, chosen.end))];
    }
  };

  const references = {
    provideReferences(doc, pos, ctx) {
      const resolved = resolveAt(doc, pos);
      if (!resolved) return null;
      resolved.symbolUri = doc.uri.toString();
      return locationsFor(resolved, !!(ctx && ctx.includeDeclaration))
        .map(h => new vscode.Location(h.uri, rangeAt(h.text, h.start, h.end)));
    }
  };

  const rename = {
    prepareRename(doc, pos) {
      const resolved = resolveAt(doc, pos);
      if (!resolved) throw new Error('This Tcl name cannot be resolved statically and is not safe to rename.');
      const entry = index.files.get(doc.uri.toString());
      return { range: rangeAt(entry.text, resolved.symbol.start, resolved.symbol.end), placeholder: resolved.symbol.name };
    },
    provideRenameEdits(doc, pos, newName) {
      if (!tclSymbols.SIMPLE_RE.test(newName)) throw new Error('Use a simple Tcl identifier when renaming; namespace moves are not supported.');
      const resolved = resolveAt(doc, pos);
      if (!resolved) return null;
      resolved.symbolUri = doc.uri.toString();
      const edit = new vscode.WorkspaceEdit();
      for (const h of locationsFor(resolved, true)) {
        let replacement = newName;
        if (resolved.kind === 'proc' || resolved.kind === 'variable') {
          const old = h.text.slice(h.start, h.end);
          const cut = old.lastIndexOf('::');
          if (cut >= 0) replacement = old.slice(0, cut + 2) + newName;
        }
        edit.replace(h.uri, rangeAt(h.text, h.start, h.end), replacement);
      }
      return edit;
    }
  };

  const symbols = {
    provideDocumentSymbols(doc) {
      const scan = index.scanOf(doc.uri) || core.scanDocument(doc.getText());
      const lineRange = (a, b) => new vscode.Range(a, 0, b, doc.lineAt(Math.min(b, doc.lineCount - 1)).text.length);
      const convert = n => {
        const sym = new vscode.DocumentSymbol(n.name, n.detail,
          n.kind === 'namespace' ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Function,
          lineRange(n.line, n.endLine), lineRange(n.line, n.line));
        sym.children = n.children.map(convert);
        return sym;
      };
      return core.buildOutline(scan).map(convert);
    }
  };

  const workspaceSymbols = {
    provideWorkspaceSymbols(query) {
      const procedural = tclSymbols.workspaceSymbols(index.entries(), query);
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const objectSymbols = [];
      for (const cls of index.workspaceOOClasses().values()) {
        const className = cls.name.replace(/^::/, '');
        if (terms.every(term => className.toLowerCase().includes(term))) for (const definition of cls.definitions) {
          objectSymbols.push({ kind: 'class', name: className, fq: className, ...definition });
        }
        for (const [method, definitions] of cls.methodDefs) {
          const display = `${className}.${method}`;
          if (!terms.every(term => display.toLowerCase().includes(term))) continue;
          for (const definition of definitions) objectSymbols.push({ kind: 'method', name: display, fq: display, ...definition });
        }
      }
      return [...procedural, ...objectSymbols].slice(0, 1000).map(symbol => {
        const entry = index.files.get(symbol.uri.toString());
        const location = new vscode.Location(symbol.uri, rangeAt(entry.text, symbol.start, symbol.end));
        const relative = vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(symbol.uri, false) : symbol.uri.toString();
        const namespace = symbol.fq.slice(0, symbol.fq.lastIndexOf('::')).replace(/^::/, '');
        const detail = [namespace, relative].filter(Boolean).join(' — ');
        const info = new vscode.SymbolInformation(symbol.fq.replace(/^::/, ''),
          symbol.kind === 'namespace' ? vscode.SymbolKind.Namespace : symbol.kind === 'class' ? vscode.SymbolKind.Class :
            symbol.kind === 'method' ? vscode.SymbolKind.Method : vscode.SymbolKind.Function,
          detail, location);
        return info;
      });
    }
  };

  const offsetAtPosition = (text, pos) => {
    let line = 0, offset = 0;
    while (line < pos.line && offset < text.length) {
      const next = text.indexOf('\n', offset);
      if (next < 0) return text.length;
      offset = next + 1;
      line++;
    }
    return Math.min(text.length, offset + pos.character);
  };
  const relativePath = uri => vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(uri, false) : uri.toString();
  const callItemForProc = proc => {
    const entry = index.files.get(proc.uri.toString());
    if (!entry) return null;
    const signature = proc.args.map(arg => arg.default === undefined ? arg.name : `?${arg.name}?`).join(' ');
    return new vscode.CallHierarchyItem(vscode.SymbolKind.Function, proc.fq.replace(/^::/, ''),
      [signature, relativePath(proc.uri)].filter(Boolean).join(' — '), proc.uri,
      rangeAt(entry.text, proc.startIdx, proc.endIdx), rangeAt(entry.text, proc.nameStart, proc.nameEnd));
  };
  const callItemForFile = entry => {
    const relative = relativePath(entry.uri);
    const name = relative.split(/[\\/]/).pop() || relative;
    const range = rangeAt(entry.text, 0, entry.text.length);
    return new vscode.CallHierarchyItem(vscode.SymbolKind.Module, name, relative, entry.uri, range,
      rangeAt(entry.text, 0, 0));
  };
  const callTargetForItem = item => {
    const entry = index.files.get(item.uri.toString());
    if (!entry) return null;
    if (item.kind === vscode.SymbolKind.Module) return { entry, proc: null };
    const offset = offsetAtPosition(entry.text, item.selectionRange.start);
    const proc = entry.scan.procs.find(candidate => candidate.nameStart <= offset && offset <= candidate.nameEnd);
    return proc ? { entry, proc: { ...proc, uri: entry.uri } } : null;
  };
  const sameProc = (a, b) => a && b && a.startIdx === b.startIdx && a.uri.toString() === b.uri.toString();

  const callHierarchy = {
    prepareCallHierarchy(doc, pos) {
      const resolved = resolveAt(doc, pos);
      return resolved && resolved.kind === 'proc' ? callItemForProc(resolved.target) : null;
    },
    provideCallHierarchyIncomingCalls(item) {
      const selected = callTargetForItem(item);
      if (!selected || !selected.proc) return [];
      const grouped = new Map();
      for (const entry of index.entries()) {
        const definitions = procDefs(entry.uri);
        for (const call of tclSymbols.procCalls(entry.text, entry.scan)) {
          const target = tclSymbols.resolveProc(call.name, entry.scan, call.start, definitions);
          if (!sameProc(target, selected.proc)) continue;
          const caller = tclSymbols.procAt(entry.scan, call.start);
          const key = caller ? `proc:${entry.uri}:${caller.startIdx}` : `file:${entry.uri}`;
          if (!grouped.has(key)) grouped.set(key, {
            from: caller ? callItemForProc({ ...caller, uri: entry.uri }) : callItemForFile(entry),
            ranges: []
          });
          grouped.get(key).ranges.push(rangeAt(entry.text, call.start, call.end));
        }
      }
      return [...grouped.values()].filter(group => group.from)
        .map(group => new vscode.CallHierarchyIncomingCall(group.from, group.ranges));
    },
    provideCallHierarchyOutgoingCalls(item) {
      const selected = callTargetForItem(item);
      if (!selected) return [];
      const grouped = new Map();
      const definitions = procDefs(selected.entry.uri);
      for (const call of tclSymbols.procCalls(selected.entry.text, selected.entry.scan)) {
        const caller = tclSymbols.procAt(selected.entry.scan, call.start);
        if (selected.proc ? (!caller || caller.startIdx !== selected.proc.startIdx) : caller) continue;
        const target = tclSymbols.resolveProc(call.name, selected.entry.scan, call.start, definitions);
        if (!target) continue;
        const key = `${target.uri}:${target.startIdx}`;
        if (!grouped.has(key)) grouped.set(key, { to: callItemForProc(target), ranges: [] });
        grouped.get(key).ranges.push(rangeAt(selected.entry.text, call.start, call.end));
      }
      return [...grouped.values()].filter(group => group.to)
        .map(group => new vscode.CallHierarchyOutgoingCall(group.to, group.ranges));
    }
  };

  // ----- quick fix: wrap unbraced expressions -----
  const codeActions = {
    provideCodeActions(doc, _range, ctx) {
      const found = diagnose(doc.getText());
      const actions = [];
      for (const d of ctx.diagnostics) {
        if (d.source !== 'Tcl Tools' || d.code !== 'unbraced-expr') continue;
        const off = doc.offsetAt(d.range.start);
        const m = found.find(f => f.start === off && f.code === d.code);
        if (!m || !m.fix) continue;
        const action = new vscode.CodeAction('Wrap expression in braces', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [d];
        action.isPreferred = true;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, new vscode.Range(doc.positionAt(m.fix.start), doc.positionAt(m.fix.end)), m.fix.text);
        actions.push(action);
      }
      return actions;
    }
  };


  // ----- semantic highlighting of calls to user-defined procs -----
  const semanticLegend = new vscode.SemanticTokensLegend(['function']);
  const semantic = {
    onDidChangeSemanticTokens: semanticChanged.event,
    provideDocumentSemanticTokens(doc) {
      const b = new vscode.SemanticTokensBuilder(semanticLegend);
      const toks = core.procCallTokens(doc.getText(), allProcLists(doc));
      for (const t of toks) b.push(new vscode.Range(t.line, t.start, t.line, t.start + t.length), 'function');
      return b.build();
    }
  };

  // ----- registration -----
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, completion, '$', ':', ' ', '-', '<', '%', '(', '/', '\\'),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, signature, ' ', '['),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerReferenceProvider(SELECTOR, references),
    vscode.languages.registerRenameProvider(SELECTOR, rename),
    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, semantic, semanticLegend),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, symbols),
    vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbols),
    vscode.languages.registerCallHierarchyProvider(SELECTOR, callHierarchy),
    vscode.languages.registerCodeActionsProvider(SELECTOR, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    diagnostics,
    semanticChanged,
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tcl.diagnostics')) vscode.workspace.textDocuments.forEach(refreshDiagnostics);
      if (e.affectsConfiguration('tcl.docLanguage')) applyDocLanguage();
      if (e.affectsConfiguration('tcl.introspection') || e.affectsConfiguration('tcl.interpreterPath') || e.affectsConfiguration('tcl.interpreterArgs')) refreshIntrospection(false);
    }),
    vscode.workspace.onDidOpenTextDocument(indexDocument),
    vscode.workspace.onDidChangeTextDocument(e => {
      const doc = e.document;
      if (doc.languageId !== 'tcl') return;
      const key = doc.uri.toString();
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => indexDocument(doc), 300));
    }),
    vscode.workspace.onDidDeleteFiles(e => { e.files.forEach(u => index.remove(u)); refreshSemantic(); refreshWorkspaceDiagnostics(); }),
    vscode.workspace.onDidRenameFiles
      ? vscode.workspace.onDidRenameFiles(async e => {
          for (const f of e.files) { index.remove(f.oldUri); if (langfiles.EXTENSIONS.some(x => f.newUri.path.toLowerCase().endsWith('.' + x))) await indexFile(f.newUri); }
          refreshSemantic();
          refreshWorkspaceDiagnostics();
        })
      : { dispose() {} },
    vscode.commands.registerCommand('tcl.explainUndefinedCommands', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'tcl') {
        vscode.window.showInformationMessage('Tcl Tools: open a Tcl file first.');
        return;
      }
      const doc = editor.document;
      const status = undefinedStatus(doc, index.scanOf(doc.uri) || core.scanDocument(doc.getText()));
      vscode.window.showInformationMessage(status.checker
        ? 'Tcl Tools: the undefined-command check is active for this file.'
        : `Tcl Tools: the undefined-command check is inactive for this file: ${status.reason}.`);
    }),
    vscode.commands.registerCommand('tcl.createProjectConfig', async () => {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) { vscode.window.showInformationMessage('Tcl Tools: open a folder first.'); return; }
      let folder = folders[0];
      if (folders.length > 1) {
        const picked = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, folder: f })), { placeHolder: 'Create .vscode/tcl-tools.json in which folder?' });
        if (!picked) return;
        folder = picked.folder;
      }
      let uri = null;
      for (const location of projectConfigs.LOCATIONS) {             // open an existing file first
        const candidate = vscode.Uri.joinPath(folder.uri, ...location.split('/'));
        try { await vscode.workspace.fs.stat(candidate); uri = candidate; break; } catch (e) { /* not there */ }
      }
      if (!uri) {
        uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tcl-tools.json');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(projectConfigs.TEMPLATE));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }),
    vscode.commands.registerCommand('tcl.showEnvironment', async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor && editor.document.languageId === 'tcl' ? editor.document : null;
      const config = cfg();
      const resolved = resolveInterpreter(vscode, context, 'run', doc ? doc.uri : undefined);
      const base = (resolved.exe || '').replace(/^.*[\\/]/, '');
      const plain = PLAIN_INTERPRETER.test(base);
      const version = vscode.workspace.isTrusted === false || !plain ? null : await probeVersion(resolved.exe);
      const status = doc ? undefinedStatus(doc, index.scanOf(doc.uri) || core.scanDocument(doc.getText())) : { reason: 'no Tcl file is open' };
      const introspect = resolveInterpreter(vscode, context, 'introspection');
      const text = buildReport({
        file: doc ? doc.uri.fsPath || doc.uri.toString() : '',
        interpreter: { exe: resolved.exe, args: resolved.args, source: resolved.source, version, plain },
        introspection: {
          enabled: config.get('introspection.enabled', true), trusted: vscode.workspace.isTrusted !== false, path: introspect.exe,
          commands: index.runtime.commands.size, procs: index.runtime.procs.length, loaded: [...index.runtime.loaded],
          errors: index.packageErrors, tk: tkState
        },
        index: { files: index.entries().length, truncated: index.truncated, max: langfiles.MAX_FILES },
        diagnostics: {
          enabled: config.get('diagnostics.enabled', true), undefinedCommands: config.get('diagnostics.undefinedCommands', 'warning'),
          knownCommands: config.get('diagnostics.knownCommands', []), undefinedStatus: status.checker ? null : status.reason
        },
        project: { files: projectState.files, commands: Object.keys(projectConfig.commands).length, knownCommands: projectConfig.knownCommands.length, hosts: Object.keys(projectConfig.hosts), matched: doc ? resolveFor(doc).hosts : [], problems: projectState.problems },
        settings: { docLanguage: config.get('docLanguage', 'auto'), testing: config.get('testing.enabled', true) }
      });
      const report = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
      await vscode.window.showTextDocument(report, { preview: true });
    }),
    vscode.commands.registerCommand('tcl.refreshIntrospection', async () => {
      await refreshIntrospection(true);
      vscode.window.showInformationMessage(
        `Tcl introspection refreshed: ${index.runtime.commands.size} commands, ${index.runtime.procs.length} package procs.`);
    })
  );

  async function refreshIntrospection(clearCache) {
    index.resetRuntime();
    warned = false;
    core.setTkRuntime(null);
    tkState = 'idle';
    core.setHandleRuntime(null);
    for (const k of Object.keys(handleState)) delete handleState[k];
    if (clearCache && context.globalState) {
      context.globalState.update('tcl.tkIntrospection', undefined);
      context.globalState.update('tcl.handleIntrospection', undefined);
    }
    await ensureRuntime([]);
    for (const doc of vscode.workspace.textDocuments) if (doc.languageId === 'tcl') await ensureRuntimeFor(doc);
    refreshSemantic();
  }

  if (vscode.workspace.onDidGrantWorkspaceTrust) {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => refreshIntrospection(false)));
  }

  if (vscode.workspace.createFileSystemWatcher) {          // files created / changed / removed outside the editor
    const watcher = vscode.workspace.createFileSystemWatcher(langfiles.GLOB);
    const onFile = async uri => { await indexFile(uri); refreshSemantic(); refreshWorkspaceDiagnostics(); };
    watcher.onDidCreate(onFile);
    watcher.onDidChange(onFile);
    watcher.onDidDelete(uri => { index.remove(uri); refreshSemantic(); refreshWorkspaceDiagnostics(); });
    context.subscriptions.push(watcher);
  }
  if (vscode.workspace.createFileSystemWatcher && vscode.RelativePattern) {      // .tcl-tools.json edits
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const location of projectConfigs.LOCATIONS) {
        const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, location));
        configWatcher.onDidCreate(loadProjectConfig);
        configWatcher.onDidChange(loadProjectConfig);
        configWatcher.onDidDelete(loadProjectConfig);
        context.subscriptions.push(configWatcher);
      }
    }
  }
  vscode.workspace.onDidSaveTextDocument && context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if (projectConfigs.isConfigPath(doc.uri.path)) loadProjectConfig();
  }));
  vscode.workspace.textDocuments.forEach(indexDocument);
  ensureRuntime([]);
  loadProjectConfig();
  indexWorkspace();
  return { index, refreshIntrospection, loadProjectConfig, projectCommands: doc => projectProcsFor(doc) };
}

module.exports = { activateProviders, TclIndex };
