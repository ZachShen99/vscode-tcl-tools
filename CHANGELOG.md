# Changelog

## Unreleased

- **Debug Test:** Test Explorer has a *Debug* profile next to *Run*. It starts the Tcl debugger on the tcltest runner, so breakpoints inside `test ... -setup/-body/-cleanup` scripts (and positional `test name desc body result` bodies) hit, and pass/fail/skip results still appear in the Test UI. The debugger now also instruments the scripts of `test` commands, so breakpoints work when you simply press F5 on a `.test` file.
- **Undefined-command warning** (`tcl.diagnostics.undefinedCommands`, default on): a command that is not built in, not an interpreter command, and whose name appears nowhere else in the workspace is reported, with a spelling hint (`putss` → `puts`). Files are skipped when something could create commands we cannot see: `rename`, `load`, wildcard `namespace import`, `namespace path`, computed `proc`/`source`, unresolved `source`, a package that did not load, `auto_path` changes, Tk, a redefined `unknown`. Only checked with a plain `tclsh`/`wish` (not Vivado-style host tools), introspection on, and a complete index; `.xdc`/`.sdc` are never checked. `tcl.diagnostics.knownCommands` adds names (wildcards allowed) and `# tcl-tools: ignore` silences a line.
- **`Tcl: Why Is the Undefined-Command Check Inactive?`**: tells why the check is not running for the current file (introspection off, untrusted workspace, host-tool interpreter, `.xdc`/`.sdc`, or which file uses which hazard such as `rename`, Tk, an unloaded package).
- **`Tcl: Show Environment Info`**: one read-only report for the current file — chosen interpreter and version, introspection state (command/proc counts, loaded and failed packages, Tk description), workspace index size and limit, diagnostic settings and whether the undefined-command check is active, with concrete suggestions for what to fix.
- **Project configuration file `.tcl-tools.json`** (`.vscode/tcl-tools.json` or the workspace folder root; both are read and merged; plain JSON, nothing in it is executed): `knownCommands` (name patterns the undefined-command check accepts, wildcards allowed) and `commands` (extra commands with `sig`, `en`, `zh` or `doc`) that appear in completion, hover and signature help and are never reported as undefined. Meant for host tools such as Vivado or Quartus whose commands the plain `tclsh` cannot list. Edits are picked up immediately, problems show in the Problems panel, a JSON schema gives editing help, and `Tcl: Create Project Config` writes a starter `.vscode/tcl-tools.json`. `Tcl: Show Environment Info` reports the loaded file.
- **Host tables in the project configuration** (`hosts` in `.vscode/tcl-tools.json`): each host has `match` glob patterns on the workspace-relative path (`**` any depth, `*` within a folder, a pattern without `/` matches in any folder), its own `commands` and `knownCommands`, and an optional `"check": true` that turns the undefined-command check on for those files (judged by the introspection interpreter, so point `tcl.introspection.interpreterPath` at a plain tclsh). Host commands show up in completion, hover and signature help only in matching files. A matching host without `check` keeps the file unchecked, and `Tcl: Why Is the Undefined-Command Check Inactive?` says so.
- Add repeatable 100/500/2000-file language-index performance baselines and CI regression budgets; index normalized paths once so full `source` dependency traversal remains fast in large workspaces.
- Debugger namespace frames now expose a dedicated Namespace Variables scope, and Commands keeps capitalised TclOO classes visible inside namespaces while still hiding private library helper procedures.
- Index literal TclOO classes, superclass/mixin relationships and methods across files; inherited instance/`my` completion, class/method definition navigation, and class/method workspace symbols now use the workspace model. TclOO definition commands have hover/signature help, and `superclass`/`mixin` complete indexed classes while omitting the current class.
- Diagnose statically certain workspace-procedure and built-in argument-count errors plus unknown/ambiguous built-in subcommands, while ignoring dynamic, expanded, ambiguous, or non-uniform calls.
- Add dependency- and namespace-aware incoming/outgoing call hierarchy for Tcl procedures, including top-level file callers.
- Add workspace symbol search for literal Tcl procedures and namespaces.
- Add literal `source` path completion and navigation, plus dependency-aware procedure resolution.
- Exercise the extension in a real VS Code host on Linux, macOS, and Windows in CI, and retain the verified VSIX packages as workflow artifacts.
- Add native Test Explorer support for `tcltest`: discover `*.test` files, run a test/file/workspace with the selected interpreter, and report pass, failure, skipped constraints, locations, output, duration, and cancellation.
- Add scope-aware cross-file definition, references, and safe rename for literal procedures and variables; ambiguous or dynamically constructed commands are left untouched.
- Limit variable completion to the current procedure or namespace instead of leaking locals from unrelated procedures.
- Select a workspace Tcl interpreter from the status bar or Command Palette. Run, background completion and the default debugger use the same choice; changing it refreshes interpreter data.
- Keep interpreter introspection results separate by package set, clear them when introspection settings change, and disable background probes in untrusted workspaces.
- Run files and selections directly through the configured interpreter in a terminal, with the source folder as the working directory; do not run a file when saving fails.
- Document newly exported `http` and `msgcat` commands, and make a missing VSIX fail the release check.
- Track tests, scripts, samples and CI in Git; run Tk tests under a virtual display and build a VSIX in CI.

## 0.6.12
- Tk widget methods are documented: after `.w ` every method (`insert`, `configure`, `curselection`, `tag`, `item`, `sashpos` ...) shows its signature with the real widget path and an English/Chinese description; hovering the method word shows the same. Methods whose meaning differs by class (`insert` of text / entry / listbox / treeview / notebook, `set` of scale / treeview ...) use the entry of the widget's own class.
- The documentation coverage report and test now enforce the widget-method table (249 class/method pairs, no gaps).

## 0.6.11
- A shared Tcl command scanner now decides what is a command: `proc` / `namespace eval` text inside strings, comments or data braces (`set template {proc x {} {}}`, `.t insert end {...}`) no longer shows up in the outline, go-to-definition, completion or call highlighting. Control-structure bodies (`if`, `switch`, `try`, `foreach`, `namespace eval`, user-defined `with_lock {...}`, `-command {...}`) are still scanned as code.
- Variable names offered after `$` and the package list used for completion are collected from real commands only, so `set x` / `package require y` inside strings, comments or data braces no longer leak in.

## 0.6.10
- Bundled package commands are now filtered by what the interpreter really provides: once a package is loaded, only the commands that exist in that Tcl version are offered (no more `tcltest::bytestring` on 9.0 or `http::quoteString` on 8.5).
- Run Selection: each run uses its own private temporary directory (mode 0700, file 0600) instead of a fixed `/tmp` file; leftovers are swept on the next run and on deactivate.
- Workspace index covers every registered extension (`.tcl .tk .tm .xdc .sdc .itcl`), follows create/change/delete/rename, and warns once when the 2000-file limit cuts the index short.
- Debugger: `source -encoding NAME file` decodes the file with that encoding; files that cannot be decoded here run through Tcl's own `source` (without breakpoints) instead of being corrupted.
- `npm run check:vsix` (also run after `npm run package`) fails when a `.vsix` in the project root does not match the version in package.json.

## 0.6.9
- Signature help while typing options: shows what the option under the cursor means (also while you type its value) and which options are still unused.
- Hover on a command (`socket`, `lsort`, `http::geturl`, `file copy` ...) lists the options it accepts.

## 0.6.8
- Debugger: the Commands scope now lists procs defined inside namespaces (what `package require platform` / `http` ... create, shown as `::platform::generic`); library namespaces (`::tcl`, `::oo`, Tk, the debugger itself) are skipped, and capitalised helper procs inside namespaces (`http::Event` ...) are hidden unless exported.
- Completion: `after `, `update ` and `binary format/scan ` no longer pop up a list right after the space; the values appear once you type a letter.

## 0.6.7
- Bundled standard packages, available after `package require`: `http` (incl. `-query/-headers/-timeout/-method ...` options), `msgcat`, `tcltest` (`test -body/-result ...`, `configure` options), `platform`, `platform::shell`, `opt`. They get completion, hover, signature help and highlighting; `namespace import ::tcltest::*` / `msgcat::*` makes the short names work too.
- TclOO: `oo::class`, `oo::define`, `oo::objdefine`, `oo::object`, `oo::copy`; declarations (`constructor`, `method`, `superclass`, `mixin`, `forward`, ...) complete inside class definitions; `my`, `self`, `next`, `nextto` inside methods; `$obj ` / `Class ` complete methods of classes defined in the file (with inheritance; private methods only after `my`).
- Chinese and English text for all of the above.

## 0.6.6
- `expr` / `if` / `while` / `for` conditions: math functions complete (`sqrt(`, `round(`, `max(` ...) with signatures, Chinese/English text, and hover; `::tcl::mathfunc::*` and `::tcl::mathop::*` commands complete and have signatures.
- Predefined variables (`$tcl_platform`, `$argv`, `$auto_path`, `$errorInfo`, ...) are documented; `$tcl_platform(` completes its keys (os, machine, pathSeparator, ...) and `$env(` completes environment variable names.
- Format specifiers: after `%` in `format`, `scan`, `clock format/scan -format` strings, and letters of `binary format/scan` strings.
- Values at fixed argument positions: `string is <class>`, `trace add/remove <type> ... <ops>`, `open` modes, `encoding` names, `seek` origin, `fileevent`/`chan event` readable|writable, `after idle|cancel|info`, `update idletasks`, `zlib stream`, `binary encode/decode` formats, `interp limit` types, `namespace ensemble`, `package prefer`.
- More option tables: channel options of `fconfigure` (sockets and serial ports, `-encoding` with values), `glob -types`, `file attributes`, `clock clicks`, `namespace which/ensemble`, `interp limit/invokehidden/cancel/debug`, `tcl::prefix match`.

## 0.6.5
- Syntax highlighting: Tk commands (`button`, `pack`, `wm`, `ttk::*`, ...) are coloured like built-in commands.
- Syntax highlighting: subcommands (`string length`, `dict get`, `package require`, `wm title`, ...) get their own scope `support.function.subcommand.tcl` (falls back to the function colour in most themes; override via `editor.tokenColorCustomizations`).
- Semantic highlighting: calls to your own procs (this file, workspace, loaded packages) are coloured as functions, in command position only. A small scanner skips comments, backslash-continued lines and multi-line double-quoted strings, and highlighting refreshes when procs change elsewhere.
- Completion and hover for options of core commands (`socket -server/-myaddr/-async`, `lsort`, `lsearch`, `regexp`, `glob`, `switch`, `exec`, `fconfigure`, `file copy -force`, `string compare -nocase`, `clock format`, ...), with Chinese/English descriptions and value lists (e.g. `-buffering none|line|full`). Options already typed are not offered again.
- Grammar is generated by `scripts/gen-grammar.py` from the command tables.

## 0.6.4
- Completion: all commands (built-in, library, your procs) use the same Function icon; subcommands keep the Method icon.

## 0.6.3
- Fix: completion no longer lists the extension's own introspection helpers (`emit`, `walk`, `main`, ...) or Tcl's internal library procs (`tclPkgSetup`, `tclPkgUnknown`, `auto_load_index`, `tclLog`); `pkg_mkIndex` now has a description.

## 0.6.2
- Fix: the completion details pane showed a command signature twice.

## 0.6.1
- Chinese descriptions also for Tk commands, `wm` / `winfo` / `tkwait` subcommands, about 117 widget options (`-text`, `-relief`, ...) and SQLite `db` methods; all follow `tcl.docLanguage`.

## 0.6.0
- Built-in command help: 20 more commands (`interp`, `binary`, `encoding`, `zlib`, `history`, `fcopy`, `load`, Tcl 9 `lremove` / `lseq` / `lpop` / `const`, ...) and about 90 more subcommands (`file`, `info`, `chan`, `array`, ...); every entry now has a description.
- Chinese descriptions for all built-in commands and subcommands; new setting `tcl.docLanguage` (`auto` follows the VS Code display language).

## 0.5.2
- New icon; repository, bugs and homepage links in the package metadata.

## 0.5.1
- Debugger: `stopOnEntry` now defaults to off, so a session runs straight to your first breakpoint (set `"stopOnEntry": true` to stop at the first command).

## 0.5.0
- Debugger: "All errors (including caught)" now also stops in `try ... on error` / `trap` handlers.
- Debugger: variables can be edited in the Variables panel (scalars, array elements, list elements, dict values).
- Debugger: *Commands* variables scope (procs, aliases, Tk widgets, TclOO objects, C handles such as an SQLite `db`), without Tcl's own library procs.
- Editor: `db` method completion, hover and signature help for SQLite handles (`sqlite3 db ...`, `set conn db`, `$conn eval`); the method list is probed from the installed SQLite.
- Packaging: icon, license, changelog, CI workflow.

## 0.4.0
- Debugger: conditional / hit-count breakpoints, logpoints, "All errors" exception filter, expandable hover and watch results, Tk event-loop and callback debugging, `db eval` / `transaction` bodies.
- Tk: completion, hover and option values layered over data introspected from the installed Tk.

## 0.3.0
- Debug adapter: breakpoints, stepping, integrated-terminal stdin, list/dict/array expansion.

## 0.2.0
- Lightweight diagnostics (unbalanced braces/quotes, unbraced `expr`) with a quick fix.

## 0.1.0
- Completion, signature help, hover, go to definition, outline; package introspection through a background `tclsh`.

## 0.0.1
- Syntax highlighting, snippets, run file/selection.
