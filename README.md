# Tcl Tools

Tcl for VS Code: editing support that learns from your installed Tcl, plus a real debugger.
Works with Tcl 8.5, 8.6, 9.0 and 9.1 (tested on all four). Written in plain JavaScript; the debugger agent is plain Tcl.

Full guide (中文/English): [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Editing
- Syntax highlighting, brackets, folding, snippets; **Run File** (`Cmd/Ctrl+F5`) and **Run Selection**.
- Run starts the configured interpreter directly in a terminal, with the source file's folder as its working directory. Each run gets its own terminal.
- Use **Tcl: Select Interpreter** or click the Tcl interpreter in the status bar to pick an installed `tclsh` (or enter its path). The workspace choice is used for Run, completion/introspection, and the default debugger. **Use configured interpreter** clears the choice.
- Completion for commands, `$variables`, subcommands (`string `, `dict `, `file `, ...), `package require` names, and procs from your workspace and from packages you `package require` (loaded in a background `tclsh`).
- Signature help, hover, scope-aware cross-file definitions and completion, Find All References, safe Rename Symbol, incoming/outgoing Call Hierarchy, a document outline, and workspace-wide procedure/namespace/class/method search (`Cmd/Ctrl+T`). TclOO classes, inheritance and methods are indexed across files for inherited object/`my` completion and definition navigation; definition commands are documented, and `superclass`/`mixin` complete workspace classes. Literal `source` paths complete and jump to the target file; their dependency graph helps disambiguate duplicate procedure names. Dynamic procedure, class, variable and path names are handled conservatively rather than guessed.
- Diagnostics include Tcl syntax errors, unbraced expressions, statically certain workspace-procedure and built-in argument-count errors, and unknown or ambiguous built-in subcommands. Dynamic calls, argument expansion, ambiguous definitions, and non-uniform command signatures are left alone.
- Descriptions for ~100 core commands and ~240 subcommands (including Tcl 9 additions such as `lremove`, `lseq`, `const`), in English or Chinese (`tcl.docLanguage`); the same goes for Tk commands and options and SQLite `db` methods.
- **Tk** (in files with `package require Tk`): widget commands, `-options` with descriptions, option values, widget methods (`.btn `), `bind` events, `wm` / `winfo` subcommands. The data comes from the Tk you have installed and is cached.
- **SQLite**: after `sqlite3 db ...` (also `set conn db`, `$conn eval`), method completion, hover and signature help for `db eval`, `db transaction`, `db onecolumn`, ...; the method list is probed from your SQLite.
- Undefined commands: a name that is not built in, not defined anywhere in the workspace and cannot come from a dynamic source is flagged (with a spelling hint). Skipped for Tk files, files that `rename`/wildcard-import/`load`, unresolved `source`s or unloaded packages, host tools such as Vivado and `.xdc`/`.sdc`; add names with `tcl.diagnostics.knownCommands`, silence a line with `# tcl-tools: ignore`. Run "Tcl: Why Is the Undefined-Command Check Inactive?" to see why a file is not being checked; "Tcl: Show Environment Info" prints the interpreter, introspection and index state for the current file.
- Project configuration: a `.vscode/tcl-tools.json` (or `.tcl-tools.json` in the workspace root; both are read and merged) lists extra commands (`commands`: signature plus English/Chinese description) and names the undefined-command check should accept (`knownCommands`, wildcards allowed), e.g. for Vivado/Quartus commands. Run "Tcl: Create Project Config" for a starter file in `.vscode/tcl-tools.json`.
  - `hosts`: per-file tables for host tools, e.g. `"vivado": {"match": ["**/*.xdc"], "knownCommands": ["get_*"], "commands": {...}, "check": false}`. Host commands apply only to matching files; `check: true` also runs the undefined-command check there (needs a plain tclsh for introspection).
- Diagnostics: unbalanced `{` `"` `[`, text after a closing brace, unbraced `expr`/`if`/`while` conditions (with a quick fix).

## Testing
Open VS Code's Test Explorer to discover `tcltest` cases in `*.test` files. You can run one test, one file, or the entire workspace; pass, failure, skipped-constraint, duration, error location, cancellation, and test output are reported through the native testing UI.

- The **Debug** profile (or *Debug Test* in the gutter menu) runs the selected tests under the Tcl debugger; breakpoints in `-setup`/`-body`/`-cleanup` scripts hit, and results are reported to the Test UI as usual (failure details go to the Debug Console).
- Tests run with the same workspace interpreter selected by **Tcl: Select Interpreter** (or `tcl.interpreterPath`) and with the test file's folder as the working directory.
- The file is saved before a run, so reported lines and executed code stay in sync.
- Discovery recognizes literal `test name description ...` and `::tcltest::test ...` declarations. Dynamically generated test names are intentionally not listed.

## Debugger
Press F5 on a `.tcl` file, or add a `launch.json` entry with `"type": "tcl"`.

- Breakpoints: line, conditional (`i == 50`), hit count (`10`, `>= 5`, `% 10`) and logpoints (`{name}`).
- Step over / into / out, continue, pause; sourced files are debugged too.
- Variables: **Locals**, **Namespace Variables**, **Globals** and **Commands** (procs, aliases, Tk widgets, TclOO classes/objects and C handles such as an SQLite `db`, with their subcommands). The namespace scope appears on frames executing inside a non-global namespace. Lists, dicts and arrays expand as trees; values can be **edited** in place.
- Hover and Watch results expand the same way; the Debug Console evaluates in the selected frame.
- Exception breakpoints: *Uncaught errors* (default) and *All errors (including caught)*, which also stops in `catch` and `try ... on error`.
- Runs in the integrated terminal (`gets stdin` works) or in the Debug Console (`"console": "internalConsole"`).
- Tk programs keep running after the script ends, like `wish`; breakpoints in callbacks (`-command {...}`, `bind`, `after`) work and appear as a `<callback>` frame.
- SQL loops (`db eval {...} { body }`) and `db transaction {...}` bodies can have breakpoints.
- Launch options: `program`, `args`, `cwd`, `interpreter`, `interpreterArgs`, `env`, `stopOnEntry` (default off), `console`.

How it works: your script is instrumented on the fly (`::__dbg::step LINE FILE;` before each command, line numbers preserved) and a small Tcl agent talks to VS Code over a local socket. Files on disk are never modified.

### Debugger limits
- Commands inside `[...]` and code built as strings (`eval`, `uplevel`) are not stepped one by one.
- Only files outside `auto_path` are instrumented. Save the file before debugging so lines match.
- *All errors* sees `error`, `catch` and `try ... on error`/`trap`; errors swallowed by other mechanisms (for example `catch` in a library) are ignored on purpose.
- Tcl 8.5 shows dict values as plain lists (no internal-representation query there).

## Settings
| Setting | Purpose |
|---|---|
| `tcl.interpreterPath`, `tcl.interpreterArgs` | Default interpreter and arguments for Run, introspection, and debugging |
| `tcl.introspection.enabled` | Learn commands, packages, Tk and SQLite from the installed Tcl |
| `tcl.introspection.tk` | Probe Tk once per file that uses it (window withdrawn, result cached) |
| `tcl.introspection.interpreterPath`, `...interpreterArgs` | Optional legacy introspection/debug override when no workspace interpreter is selected; the path must be a plain `tclsh` |
| `tcl.docLanguage` | Language of built-in command descriptions: `auto` (follow VS Code), `en`, `zh` |
| `tcl.diagnostics.enabled` | Diagnostics on/off |
| `tcl.diagnostics.undefinedCommands` | `warning` (default) or `off` for the undefined-command check |
| `tcl.diagnostics.knownCommands` | Extra command names (wildcards allowed) the undefined-command check treats as defined |
| `tcl.testing.enabled` | Discover and run `tcltest` tests in Test Explorer |
| `tcl.testing.filePattern` | Workspace glob for test files (default `**/*.test`) |
| `tcl.testing.exclude` | Workspace glob excluded from test discovery |

Command: **Tcl: Refresh Introspection** forgets cached results and probes again. With introspection off, built-in tables are used.
Background introspection loads packages named by `package require`; it runs only in trusted workspaces. Changing the introspection interpreter or its arguments refreshes the results.
An explicit `interpreter` in `launch.json` overrides the workspace choice for that debug configuration. If Run uses a host tool such as Vivado, set `tcl.interpreterPath` to that tool and `tcl.introspection.interpreterPath` to a plain `tclsh`, then use **Use configured interpreter** in the picker.

## Notes
- macOS system `tclsh` is 8.5 (no `lmap`/`try`); install Tcl 8.6+ (for example Homebrew) and set the interpreter settings.
- Procs are found by a small Tcl-aware scanner (comments, strings and data braces are skipped); procs created dynamically (`proc` inside `eval`, string-built names) are invisible.
- Debugging needs a plain `tclsh`, not `wish`.

## Build

This public repository contains the extension source used for releases. Install the dependencies and build a VSIX with:

```sh
npm install
npm run package
```
## License
MIT, Copyright (c) 2026 Zach Shen
