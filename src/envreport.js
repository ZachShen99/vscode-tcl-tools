'use strict';
// "Tcl: Show Environment Info": a plain-text report of everything that decides how the extension behaves
// for the current file (vscode-independent so it can be unit-tested).

const yesNo = v => (v ? 'yes' : 'no');
const list = (items, max = 12) => {
  const arr = [...items];
  if (!arr.length) return '(none)';
  return arr.slice(0, max).join(', ') + (arr.length > max ? `, … (+${arr.length - max} more)` : '');
};

/**
 * @param {object} i {
 *   file, interpreter:{exe,args,source,version,plain}, introspection:{enabled, trusted, path, commands, procs, packages, loaded, errors:[{pkg,message}], tk},
 *   index:{files, truncated, max}, diagnostics:{enabled, undefinedCommands, undefinedStatus: string|null, knownCommands:[]},
 *   settings:{docLanguage, testing}
 * }
 */
function buildReport(i) {
  const out = [];
  const add = (...l) => out.push(...l);
  add('Tcl Tools environment', '=====================', '');
  add(`File: ${i.file || '(no Tcl file open)'}`, '');
  const it = i.interpreter;
  add('Interpreter',
    `  executable : ${it.exe || '(none)'}${it.args && it.args.length ? ' ' + it.args.join(' ') : ''}`,
    `  chosen by  : ${it.source}`,
    `  version    : ${it.version || 'unknown (could not run it, or it is not a plain tclsh)'}`,
    `  plain tclsh/wish: ${yesNo(it.plain)}${it.plain ? '' : '  (host tools such as Vivado are not used for static checks)'}`, '');
  const n = i.introspection;
  add('Introspection',
    `  enabled    : ${yesNo(n.enabled)}`,
    `  trusted workspace: ${yesNo(n.trusted)}`,
    `  interpreter: ${n.path || it.exe}`,
    `  commands   : ${n.commands}`,
    `  package procs: ${n.procs}`,
    `  loaded packages : ${list(n.loaded)}`,
    `  failed packages : ${n.errors.length ? n.errors.map(e => `${e.pkg} (${e.message || 'error'})`).join('; ') : '(none)'}`,
    `  Tk description : ${n.tk}`, '');
  const x = i.index;
  add('Workspace index',
    `  Tcl files  : ${x.files}${x.truncated ? `  (limit of ${x.max} reached: cross-file features are incomplete)` : ''}`, '');
  const d = i.diagnostics;
  add('Diagnostics',
    `  tcl.diagnostics.enabled          : ${d.enabled}`,
    `  tcl.diagnostics.undefinedCommands: ${d.undefinedCommands}`,
    `  tcl.diagnostics.knownCommands    : ${d.knownCommands.length ? d.knownCommands.join(', ') : '(none)'}`,
    `  undefined-command check for this file: ${d.undefinedStatus ? 'inactive — ' + d.undefinedStatus : 'active'}`, '');
  if (i.project) {
    const pr = i.project;
    add('Project configuration',
      `  files      : ${pr.files.length ? pr.files.join(', ') : '(none found; "Tcl: Create Project Config" makes one)'}`,
      `  commands   : ${pr.commands}`,
      `  knownCommands patterns: ${pr.knownCommands}`,
      `  hosts      : ${pr.hosts && pr.hosts.length ? pr.hosts.join(', ') : '(none)'}; matching this file: ${pr.matched && pr.matched.length ? pr.matched.join(', ') : '(none)'}`,
      `  problems   : ${pr.problems.length ? pr.problems.join('; ') : '(none)'}`, '');
  }
  add('Other settings',
    `  tcl.docLanguage : ${i.settings.docLanguage}`,
    `  tcl.testing.enabled: ${yesNo(i.settings.testing)}`, '');
  const hints = [];
  if (!n.enabled) hints.push('Introspection is off: completion of package commands and the undefined-command check are limited. Set tcl.introspection.enabled to true.');
  if (!n.trusted) hints.push('The workspace is not trusted: the extension will not run the interpreter. Trust the workspace to enable introspection.');
  if (n.enabled && n.trusted && n.commands < 30) hints.push('Introspection has not produced a command list. Run "Tcl: Refresh Introspection" and check the "Tcl Tools" output channel.');
  if (!it.version && it.plain) hints.push(`The interpreter "${it.exe}" could not be run. Use "Tcl: Select Interpreter".`);
  if (n.errors.length) hints.push('Some packages failed to load in the interpreter; their commands are unknown and files requiring them are skipped by the undefined-command check.');
  if (i.project && i.project.problems.length) hints.push('The project configuration file has problems (see above and the Problems panel).');
  if (x.truncated) hints.push('The index hit the file limit; narrow the workspace or exclude generated folders.');
  add('Suggestions', ...(hints.length ? hints.map(h => `  - ${h}`) : ['  - nothing to fix']));
  return out.join('\n') + '\n';
}

module.exports = { buildReport };
