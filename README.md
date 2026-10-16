# Tcl Tools

[中文说明](#tcl-tools-中文说明)

Tcl for VS Code: editing support that learns from your installed Tcl, plus a real debugger.
Works with Tcl 8.5, 8.6, 9.0 and 9.1 (tested on all four). Written in plain JavaScript; the debugger agent is plain Tcl.

Full guide: [English](docs/USER_GUIDE.md) | [中文](docs/USER_GUIDE.zh-CN.md). New here? Run **Tcl: Get Started (Walkthrough)** for a short guided tour.

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

---

# Tcl Tools 中文说明

[返回 English](#tcl-tools)

Tcl Tools 是面向 VS Code 的 Tcl 开发扩展：提供能够学习本机 Tcl 环境的编辑功能，以及真正可用的 Tcl 调试器。
支持 Tcl 8.5、8.6、9.0 和 9.1，并在这些版本上持续测试。扩展主体使用纯 JavaScript，调试代理使用纯 Tcl。

完整指南：[中文](docs/USER_GUIDE.zh-CN.md) | [English](docs/USER_GUIDE.md)。第一次使用时，可运行 **Tcl: 开始使用（引导）**，通过简短的交互式导览了解主要功能。

## 编辑功能

- 语法高亮、括号匹配、代码折叠、代码片段，以及 **运行当前文件**（`Cmd/Ctrl+F5`）和 **运行选中内容**。
- 运行命令会直接在终端中启动所选解释器，以源文件所在目录为工作目录；每次运行使用独立终端。
- 运行 **Tcl: 选择解释器**，或点击状态栏中的 Tcl 解释器，选择已经安装的 `tclsh` 或手动输入路径。工作区选择会统一用于运行、自省补全、测试和默认调试配置。
- 补全命令、`$变量`、子命令（如 `string `、`dict `、`file `）、`package require` 包名，以及工作区和已加载包中的过程。
- 提供签名帮助、悬停说明、跨文件定义跳转、查找所有引用、安全重命名、调用层次、文档大纲和工作区符号搜索（`Cmd/Ctrl+T`）。
- 跨文件索引 TclOO 类、继承和方法；支持对象及 `my` 的继承成员补全和定义跳转，`superclass`/`mixin` 可补全工作区类。
- 字面量 `source` 路径可补全并跳转到目标文件；依赖关系会帮助区分同名过程。动态生成的过程、类、变量和路径会被保守处理，不会随意猜测。
- 诊断包括 Tcl 语法错误、未加花括号的表达式、能够静态确定的参数数量错误，以及未知或有歧义的内置子命令。
- 约 100 个核心命令和约 240 个子命令带有中英文说明，包括 Tcl 9 的 `lremove`、`lseq`、`const`、`timer` 和 `unicode` 等新功能。说明语言由 `tcl.docLanguage` 控制。
- **Tk**：在包含 `package require Tk` 的文件中补全部件命令、选项、选项值、部件方法、`bind` 事件以及 `wm`/`winfo` 子命令。数据来自已安装的 Tk，并会缓存。
- **SQLite**：识别 `sqlite3 db ...`、`set conn db` 和 `$conn eval` 等写法，为 `db eval`、`db transaction`、`db onecolumn` 等方法提供补全、悬停和签名帮助。
- 未定义命令检查会标记既不是内置命令、又未在工作区中定义且不可能来自动态来源的名称，并提供拼写建议。可以使用 `tcl.diagnostics.knownCommands` 增加命令，或用 `# tcl-tools: ignore` 忽略一行。
- 项目可以通过工作区根目录的 `.tcl-tools.json` 或 `.vscode/tcl-tools.json` 描述 Vivado、Quartus 或自有框架提供的额外命令。运行 **Tcl: 创建项目配置** 可生成起始文件。

## 测试

VS Code 的测试视图会发现 `*.test` 文件中的 `tcltest` 用例。可以运行单个用例、单个文件或整个工作区；通过、失败、约束跳过、耗时、错误位置、取消和输出都会显示在原生测试界面中。

- **Debug** 配置会在 Tcl 调试器下运行所选测试，`-setup`、`-body` 和 `-cleanup` 脚本中的断点能够命中。
- 测试使用 **Tcl: 选择解释器** 选中的工作区解释器，并以测试文件所在目录作为工作目录。
- 运行前会先保存测试文件，确保执行内容和报告行号一致。
- 测试发现支持字面量形式的 `test name description ...` 和 `::tcltest::test ...`；动态生成的测试名称不会列出。

## 调试器

在 `.tcl` 文件中按 `F5`，或者在 `launch.json` 中添加一个 `"type": "tcl"` 的配置。

- 支持普通断点、条件断点（`i == 50`）、命中次数（`10`、`>= 5`、`% 10`）和日志点（`{name}`）。
- 支持单步越过、进入、跳出、继续和暂停；通过 `source` 加载的文件同样可以调试。
- 变量视图包含局部变量、命名空间变量、全局变量和命令。列表、字典和数组可以展开为树，也可以直接修改值。
- 悬停和监视表达式同样可以展开；调试控制台会在选中的栈帧中求值。
- 异常断点包括默认的 *Uncaught errors*，以及会在 `catch` 和 `try ... on error` 中停下的 *All errors (including caught)*。
- 可以在集成终端中运行（支持 `gets stdin`），也可以把输出发送到调试控制台。
- Tk 脚本结束后窗口会像 `wish` 一样继续运行；`-command`、`bind` 和 `after` 回调中的断点有效。
- `db eval` 循环和 `db transaction` 的脚本体中也可以设置断点。

调试器会在运行时为脚本插桩，并通过本机套接字与 VS Code 通信；磁盘上的源文件不会被修改。

### 调试限制

- `[...]` 内部的命令，以及由 `eval`、`uplevel` 等字符串动态生成的代码，不能逐条单步执行。
- 只会插桩 `auto_path` 之外的文件。调试前请保存文件，确保行号一致。
- Tcl 8.5 无法查询内部表示，因此字典值会显示为普通列表。

## 设置

| 设置 | 用途 |
|---|---|
| `tcl.interpreterPath`、`tcl.interpreterArgs` | 运行、自省和调试所用的默认解释器及参数 |
| `tcl.introspection.enabled` | 从已安装的 Tcl 学习命令、包、Tk 和 SQLite 信息 |
| `tcl.introspection.tk` | 对使用 Tk 的文件探测 Tk 信息并缓存结果 |
| `tcl.introspection.interpreterPath`、`...interpreterArgs` | 未选择工作区解释器时使用的自省解释器；必须是普通 `tclsh` |
| `tcl.docLanguage` | 内置说明语言：`auto`、`en` 或 `zh` |
| `tcl.diagnostics.enabled` | 开启或关闭诊断 |
| `tcl.diagnostics.undefinedCommands` | 未定义命令检查：`warning`（默认）或 `off` |
| `tcl.diagnostics.knownCommands` | 额外认可的命令名，支持通配符 |
| `tcl.testing.enabled` | 在测试视图中发现并运行 `tcltest` 测试 |
| `tcl.testing.filePattern` | 测试文件的工作区 glob，默认 `**/*.test` |
| `tcl.testing.exclude` | 测试发现需要排除的路径 glob |

**Tcl: 刷新自省** 会清除缓存并重新探测。后台自省只在受信任的工作区中运行。如果运行脚本需要 Vivado 等宿主工具，可以把 `tcl.interpreterPath` 指向宿主工具，把 `tcl.introspection.interpreterPath` 指向普通 `tclsh`。

## 注意事项

- macOS 自带的 `tclsh` 是 8.5；建议安装 Tcl 8.6 或更新版本，并在扩展中选择它。
- 扩展通过轻量 Tcl 感知扫描器查找过程；由字符串或 `eval` 动态生成的过程不可见。
- 调试需要普通 `tclsh`，不能使用 `wish`。

## 构建

```sh
npm install
npm run package
```

生成的 `tcl-tools-*.vsix` 可以通过 VS Code 扩展视图中的 **Install from VSIX...** 安装。

## 许可证

MIT，Copyright (c) 2026 Zach Shen
