# User Guide

English | [中文](USER_GUIDE.zh-CN.md)

Applies to: 0.6.x (including the unreleased features). This is the full user-facing guide; for development and release notes see [`../README.md`](../README.md), [`PERFORMANCE.md`](PERFORMANCE.md) and [`PYTHON_EXTENSION_GAP.md`](PYTHON_EXTENSION_GAP.md).

## Contents
1. [Quick start](#1-quick-start)
2. [Choosing an interpreter](#2-choosing-an-interpreter)
3. [Editing features](#3-editing-features)
4. [Diagnostics](#4-diagnostics)
5. [Project configuration file](#5-project-configuration-file)
6. [Running code](#6-running-code)
7. [Testing with tcltest](#7-testing-with-tcltest)
8. [Debugging](#8-debugging)
9. [Settings reference](#9-settings-reference)
10. [Command reference](#10-command-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Known limits](#12-known-limits)
13. [Appendix: getting-started walkthrough](#13-appendix-getting-started-walkthrough)

---

## 1. Quick start

1. Install the extension from the Marketplace once it is public. For a test build, open the `…` menu in VS Code's Extensions view, choose **Install from VSIX...**, select `tcl-tools-*.vsix`, and reload when prompted.
2. Install a Tcl 8.6+ `tclsh` (the macOS system `tclsh` is 8.5 and lacks `lmap`/`try`; install another one, for example with Homebrew).
3. Open a folder containing `.tcl` files. The Tcl interpreter appears in the status bar; click it (or run **Tcl: Select Interpreter**) to pick your `tclsh`.
4. Open a `.tcl` file and start typing for completion, hover documentation and diagnostics. `Ctrl+Space` manually triggers completion, `Cmd/Ctrl+F5` runs the current file, and `F5` debugs it.
5. If a package's commands are missing from completion, add `package require name`; the extension loads it in a background `tclsh` and learns its commands.

Recognized extensions are `.tcl`, `.tk`, `.tm`, `.test`, `.xdc`, `.sdc` and `.itcl`. Open a **folder/workspace**, not just a single file, so cross-file indexing, project configuration and the Test Explorer have complete context.

---

## 2. Choosing an interpreter

- **Tcl: Select Interpreter** (or the status-bar item) lists `tclsh` executables found on `PATH` and lets you enter a path. The choice is stored for the workspace and used for **running, completion/introspection, debugging and testing**. *Use configured interpreter* clears it and falls back to `tcl.interpreterPath`.
- Settings: `tcl.interpreterPath` (default `tclsh`) and `tcl.interpreterArgs`.
- Completion and diagnostics rely on *introspection*: the extension starts a **plain tclsh** in the background and asks it which commands, packages and Tk widgets exist. Introspection runs only in **trusted workspaces**; with `tcl.introspection.enabled` off, only the built-in tables are used.
- If you normally run scripts through a host tool such as Vivado or Quartus: set `tcl.interpreterPath` to the host tool, set `tcl.introspection.interpreterPath` to a plain `tclsh`, then choose *Use configured interpreter* in the picker.
- The debugger needs a plain `tclsh` (not `wish`). An explicit `interpreter` in `launch.json` applies to that debug configuration only.

---

## 3. Editing features

| Feature | Notes |
|---|---|
| Highlighting, brackets, folding, snippets | Work out of the box; `*.test` files are treated as Tcl |
| Completion | Commands, `$variables`, subcommands (`string `, `dict `, `file ` …), `package require` names, procs from the workspace and loaded packages, namespace members, `-options` and their values |
| Signature help and hover | Built-in commands and subcommands, proc parameter lists, option descriptions |
| Navigation | Cross-file go to definition, find all references, safe rename, call hierarchy (incoming/outgoing), document outline |
| Workspace symbols | `Cmd/Ctrl+T`: procs, namespaces, classes, methods |
| `source` support | Literal paths complete and jump; the `source` graph disambiguates duplicate proc names |
| TclOO | Classes, inheritance (`superclass`/`mixin`) and methods indexed across files; completion and navigation for objects and `my` |
| Tk | In files with `package require Tk`: widget commands, `-options` with descriptions, option values, widget methods (after `.btn `), `bind` events, `wm`/`winfo` subcommands. Data comes from your installed Tk and is cached |
| SQLite | After `sqlite3 db ...` (also `set conn db`, `$conn eval`): completion, hover and signature help for `db eval`, `db transaction`, `db onecolumn` and more |
| Documentation language | `tcl.docLanguage`: `auto` (follow VS Code's display language), `en`, `zh`; covers ~100 core commands, ~240 subcommands (including Tcl 9 additions such as `lremove`, `lseq`, `const`), Tk commands and options, SQLite methods |

Dynamically built proc, class and variable names and paths are handled **conservatively**: when the extension cannot be sure, it neither guesses nor reports an error.

---

## 4. Diagnostics

### Built-in diagnostics

`tcl.diagnostics.enabled` is the master switch. Reported: unbalanced `{` `"` `[`, text after a closing brace, unbraced `expr`/`if`/`while` conditions (with a quick fix), argument-count errors for workspace procs and built-ins that are *statically certain*, and unknown or ambiguous built-in subcommands. Dynamic calls, `{*}` expansion, ambiguous definitions and commands with non-uniform signatures are never reported.

### Undefined-command warning

A command is reported only if all of these hold, so a warning essentially means "this name exists nowhere": it is not built in, it is not an interpreter command, and the name does not appear **anywhere else** in the workspace (a definition, `interp alias`, `coroutine`, even a mention in a comment or string counts as "appearing"). When a known command is spelled similarly you get a hint, for example `putss` → `puts`.

The whole file is **skipped** in these cases (missing a typo is preferred to a false alarm):

- The file, or a file it `source`s, uses `rename`, `load`, `auto_load`, `auto_mkindex`, `auto_reset`, redefines `unknown`, uses `namespace import` with wildcards, `namespace path`, a computed `proc` name, changes `auto_path`/`tcl::tm::path`, or has a dynamic or unresolvable `source`.
- It uses Tk/Ttk, or a `package require`d package failed to load in the interpreter.
- It is an `.xdc`/`.sdc` file, or the configured interpreter is not a plain `tclsh`/`wish` (host tools).
- Introspection is off, the workspace is untrusted, or the workspace index is incomplete (too many files).

Controls:

- `tcl.diagnostics.undefinedCommands`: `warning` (default) or `off`.
- `tcl.diagnostics.knownCommands`: extra accepted names with `*`/`?` wildcards, e.g. `["get_*"]`.
- `# tcl-tools: ignore` on the same line or the line above silences that line.
- To find out why the current file is not checked, run **Tcl: Why Is the Undefined-Command Check Inactive?**; it names the exact reason (for example which file uses `rename`).

---

## 5. Project configuration file

```json
{
  "knownCommands": ["set_property"],
  "commands": {
    "get_cells": {
      "sig": "?-hierarchical? ?-filter expr? ?patterns?",
      "en": "Get cells of the current design",
      "zh": "获取当前设计中的 cell"
    }
  },
  "hosts": {
    "vivado": {
      "match": ["**/*.xdc", "constraints/*.tcl"],
      "knownCommands": ["get_*"],
      "commands": { "create_clock": "-period p ?-name n? objects" },
      "check": false
    }
  }
}
```

Use this to describe commands the extension cannot see: host tools (Vivado, Quartus …) or your own frameworks. The file is **plain JSON and is never executed**, so it works in untrusted workspaces as well.

Both locations are read and merged. The workspace-root `.tcl-tools.json` is read first; `.vscode/tcl-tools.json` is read afterwards and overrides `commands` or `hosts` with the same name, while `knownCommands` are combined and deduplicated. **Tcl: Create Project Config** writes a starter file to `.vscode/tcl-tools.json`. A JSON schema gives editing help. Changes apply as soon as the file is saved or changed on disk, and format problems appear in the Problems panel. See the example above.

- `knownCommands`: names the undefined-command check accepts; wildcards allowed.
- `commands`: extra commands. A value is a signature string or an object `{sig, en, zh, doc}` (`doc` serves both languages when `en`/`zh` are missing). Names may be namespaced, e.g. `a::b::run`. They appear in completion, hover and signature help and are never reported as undefined.
- `hosts`: tables that apply per file. `match` holds globs on the **workspace-relative path**: `**` crosses folders, `*` stays within one folder, `?` is one character; a pattern without `/` (such as `*.sdc`) matches in any folder, case-insensitively. A host's `commands`/`knownCommands` apply only to the files it matches.
- `check` (default `false`): when `true`, matching files also get the undefined-command check, judged by the *introspection* interpreter (`tcl.introspection.interpreterPath`, which must be a plain `tclsh`). **An incomplete host table produces false alarms**, so start with `false` for completion and enable it once the table is complete.
- A host without `match` never applies and is flagged.

---

## 6. Running code

- **Run File** (`Cmd/Ctrl+F5`, or the run button in the editor title bar) saves the current file first, then starts the configured interpreter directly in a terminal. The source file's folder is the working directory and each run gets its own terminal. Untitled files must be saved first.
- **Run Selection** runs the selection, or the current line when the selection is empty. The code is placed in a permission-restricted temporary file; the source file on disk is not rewritten.
- Arguments in `tcl.interpreterArgs` are placed before the script path.

---

## 7. Testing with tcltest

Open VS Code's Test Explorer; the extension discovers `tcltest` cases in `*.test` files (`tcl.testing.filePattern`, default `**/*.test`). Run one test, one file or the whole workspace; pass, failure, skipped constraints, duration, error location, cancellation and output are reported through the native testing UI.

- The **Run** profile uses the same interpreter as *Run File*, with the test file's folder as working directory; the file is saved first.
- The **Debug** profile (or *Debug Test* in the gutter menu) runs the selected tests under the Tcl debugger; breakpoints in `-setup`, `-body` and `-cleanup` scripts hit. Results are reported to the Test UI as usual; failure details go to the Debug Console.
- Only literal `test name description ...` and `::tcltest::test ...` declarations are recognized; **tests with dynamically generated names are not listed**.
- `tcl.testing.enabled` turns the feature off; `tcl.testing.exclude` excludes folders (default `**/{.git,node_modules,.venv}/**`).

---

## 8. Debugging

```json
{
  "type": "tcl",
  "request": "launch",
  "name": "Debug current Tcl file",
  "program": "${file}",
  "args": [],
  "stopOnEntry": false,
  "console": "integratedTerminal"
}
```

Press `F5` on a `.tcl` file or add a `"type": "tcl"` entry to `launch.json` (see the example above).

Launch options: `program` (required), `args`, `cwd` (default: the script's folder), `interpreter`, `interpreterArgs`, `env`, `stopOnEntry` (default `false`: run to your breakpoints), `console` (`integratedTerminal` supports stdin; `internalConsole` captures output in the Debug Console, no stdin).

Features:

- **Breakpoints**: plain, conditional (`i == 50`), hit count (`10`, `>= 5`, `% 10`) and logpoints (`{name}`).
- **Stepping**: over, into, out, continue, pause; `source`d files are debugged too, and `source -encoding NAME file` is decoded with the requested encoding.
- **Variables**: locals, namespace variables, globals, plus *Commands* (procs, aliases, Tk widgets, TclOO classes/objects and C handles such as an SQLite `db`, with their subcommands). Lists, dicts and arrays expand as trees; values can be **edited in place**.
- Hover and Watch results expand the same way; the Debug Console evaluates in the selected frame.
- **Exception breakpoints**: *Uncaught errors* (default) and *All errors (including caught)*, which also stops in `catch` and `try ... on error`.
- **Tk programs** keep running after the script ends, like `wish`; breakpoints in `-command {...}`, `bind` and `after` callbacks work and appear as a `<callback>` frame.
- SQL loops (`db eval {...} { body }`) and `db transaction {...}` bodies accept breakpoints.

How it works: your script is instrumented on the fly (`::__dbg::step LINE FILE;` before each command, line numbers preserved) and a small Tcl agent talks to VS Code over a local socket. **Files on disk are never modified.**

**Debugger limits**

- Commands inside `[...]` and code built as strings (`eval`, `uplevel`) are not stepped one by one.
- Only files outside `auto_path` are instrumented; save the file before debugging so lines match.
- *All errors* sees `error`, `catch` and `try ... on error`/`trap`; errors swallowed by other mechanisms are ignored on purpose.
- Tcl 8.5 shows dict values as plain lists.

---

## 9. Settings reference

| Setting | Default | Description |
|---|---|---|
| `tcl.interpreterPath` | `tclsh` | Default interpreter for run, introspection and debug |
| `tcl.interpreterArgs` | `[]` | Arguments placed before the script path |
| `tcl.introspection.enabled` | `true` | Learn commands, packages, Tk and SQLite from the installed Tcl |
| `tcl.introspection.tk` | `true` | Probe Tk once per file that uses it (window withdrawn, cached) |
| `tcl.introspection.interpreterPath` | empty | Alternative for introspection and default debugging; must be a plain `tclsh`; a workspace selection takes precedence |
| `tcl.introspection.interpreterArgs` | `[]` | Arguments for the introspection interpreter |
| `tcl.docLanguage` | `auto` | Language of built-in descriptions; untranslated ones fall back to English |
| `tcl.diagnostics.enabled` | `true` | Diagnostics master switch |
| `tcl.diagnostics.undefinedCommands` | `warning` | `warning` or `off` |
| `tcl.diagnostics.knownCommands` | `[]` | Extra accepted command names with `*`, `?` |
| `tcl.testing.enabled` | `true` | Discover and run `tcltest` in the Test Explorer |
| `tcl.testing.filePattern` | `**/*.test` | Workspace glob for test files |
| `tcl.testing.exclude` | `**/{.git,node_modules,.venv}/**` | Glob excluded from test discovery |

---

## 10. Command reference

Type `Tcl` in the Command Palette (`Cmd/Ctrl+Shift+P`).

| Command | What it does |
|---|---|
| Tcl: Run Current File | Run the current file |
| Tcl: Run Selection | Run the selection |
| Tcl: Select Interpreter | Pick the interpreter; also available from the status bar |
| Tcl: Refresh Introspection | Forget cached results and probe again |
| Tcl: Why Is the Undefined-Command Check Inactive? | Explain why the undefined-command check is not running for the current file |
| Tcl: Show Environment Info | Report interpreter, introspection, index, diagnostics and project-config state with suggestions |
| Tcl: Get Started (Walkthrough) | Open the getting-started walkthrough |
| Tcl: Open User Guide | Open this guide as a rendered preview |
| Tcl: Open Sample File | Open the sample file (kept in extension storage; your edits persist) |
| Tcl: Create Project Config | Create a starter `.vscode/tcl-tools.json` (opens it if it exists) |

---

## 11. Troubleshooting

When something looks wrong, run **Tcl: Show Environment Info** first. It lists the interpreter and version used for the current file, whether introspection is on and working, loaded and failed packages, the number of indexed files, and concrete suggestions.

| Symptom | Cause and fix |
|---|---|
| A package's commands are missing | The file lacks `package require`, or the package fails to load in your interpreter (listed in the environment report); make sure `tclsh` can load it, then run **Tcl: Refresh Introspection** |
| No undefined-command warnings at all | Run **Tcl: Why Is the Undefined-Command Check Inactive?**. Common causes: introspection off, untrusted workspace, a non-plain interpreter, the file uses Tk or `rename`, etc. |
| A valid command is reported as undefined | Add it to `tcl.diagnostics.knownCommands` or the project config's `knownCommands`/`commands`, or add `# tcl-tools: ignore` on that line |
| Using Vivado/Quartus, completion and diagnostics are off | Set `tcl.introspection.interpreterPath` to a plain `tclsh` and describe the host commands in the project config (`commands`/`hosts`) |
| `lmap`/`try` missing on macOS | The system `tclsh` is 8.5; install 8.6+ and select it |
| The debugger does not start | Debugging needs a plain `tclsh`, not `wish`; check `interpreter` in `launch.json` and the interpreter shown by **Show Environment Info** |
| A breakpoint does not stop | Save the file first; commands inside `[...]` and code built for `eval`/`uplevel` are not stepped; files under `auto_path` are not instrumented |
| A test case is not listed | Only literally named tests are listed; check that the file matches `tcl.testing.filePattern` and is not excluded by `tcl.testing.exclude` |
| A setting changed in the Settings UI seems to have no effect | Check whether the setting is at user, workspace or language scope, then run **Tcl: Show Environment Info** to confirm the value seen for the current file. Diagnostic and introspection settings refresh after changes. If it still looks wrong, select **Tcl Tools** in the Output panel for logs |
| No change after editing `.vscode/tcl-tools.json` | Save the file; format errors appear in the Problems panel and the offending entries are ignored. The "Project configuration" section of **Show Environment Info** lists the files that were read |

---

## 12. Known limits

- Procs are found by a small Tcl-aware scanner (comments, strings and data braces are skipped); **dynamically created procs** (`proc` inside `eval`, string-built names) are invisible.
- The undefined-command check is **conservative**: it prefers missing a typo to a false alarm, only looks at words in command position and ignores dynamic calls such as `$cmd args`; host files need to be described in the project config.
- With more than 2000 Tcl files in the workspace, cross-file features cover only the first 2000 and the undefined-command check is switched off.
- Debugger limits: see section 8.
- The debugger currently supports local `launch` only; it cannot attach, debug remotely or connect to an already-running Tcl process.
- There is no built-in formatter, linter or refactoring other than rename yet.

---

## 13. Appendix: getting-started walkthrough

The getting-started walkthrough is implemented as a VS Code Walkthrough (`contributes.walkthroughs`; the text lives in `media/walkthrough/`). Only one language is shown, chosen by VS Code's display language (English is the default file, Chinese lives in the matching `*.nls.zh.md`; command and walkthrough titles are in `package.nls.json` / `package.nls.zh-cn.json`). It has 8 steps, each with a clickable command:

| Step | Title | Action | Source |
|---|---|---|---|
| 1 | Pick an interpreter | `tcl.selectInterpreter` | Section 2 |
| 2 | Check your environment | `tcl.showEnvironment` | Section 11 |
| 3 | Try the sample file | `tcl.openWalkthroughSample` | Section 3 |
| 4 | Run a script | `tcl.runFile` | Section 6 |
| 5 | Run tests | Testing view | Section 7 |
| 6 | Debug a script | start debugging | Section 8 |
| 7 | Describe host commands (optional) | `tcl.createProjectConfig` | Section 5 |
| 8 | Where to go next | `tcl.showEnvironment` | Section 11 |

The sample file (`sample.tcl` in English, `sample.zh.tcl` in Chinese, chosen by `tcl.docLanguage` or the display language) has a namespace, a proc and one deliberately misspelled command; it is copied to the extension's storage on first use and never overwritten afterwards. When editing the walkthrough keep the misspelled name as the only mention (a mention in a comment would hide the undefined-command warning); `test/onboarding.test.js` checks this.
