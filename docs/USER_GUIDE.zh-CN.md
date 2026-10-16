# 使用指南

[English](USER_GUIDE.md) | 中文

适用版本：0.6.x（含 Unreleased 中的新功能）。本文是面向使用者的完整说明；开发与发布相关内容见 [`../README.md`](../README.md)、[`PERFORMANCE.md`](PERFORMANCE.md)、[`PYTHON_EXTENSION_GAP.md`](PYTHON_EXTENSION_GAP.md)。

## 目录
1. [快速开始](#1-快速开始)
2. [选择解释器](#2-选择解释器)
3. [编辑功能](#3-编辑功能)
4. [诊断](#4-诊断)
5. [项目配置文件](#5-项目配置文件)
6. [运行](#6-运行)
7. [测试](#7-测试)
8. [调试](#8-调试)
9. [设置参考](#9-设置参考)
10. [命令参考](#10-命令参考)
11. [故障排查](#11-故障排查)
12. [已知限制](#12-已知限制)
13. [附录：入门引导](#13-附录入门引导)

---

## 1. 快速开始

1. 安装扩展：公开发布后可从 Marketplace 安装；使用测试版时，在 VS Code 的“扩展”视图打开 `…` 菜单，选择 **Install from VSIX...**，选中 `tcl-tools-*.vsix`，然后按提示重新加载窗口。
2. 安装一个 Tcl 8.6 或更新的 `tclsh`（macOS 自带的是 8.5，没有 `lmap`/`try`，建议用 Homebrew 另装）。
3. 打开一个包含 `.tcl` 文件的文件夹。状态栏右侧会出现 Tcl 解释器，点击它（或运行 **Tcl: Select Interpreter**）选择你要用的 `tclsh`。
4. 打开 `.tcl` 文件，开始输入即可获得补全、悬停说明和诊断；`Ctrl+Space` 可手动触发补全，`Cmd/Ctrl+F5` 运行当前文件，`F5` 调试。
5. 如果补全里缺少某个包的命令，在文件里写 `package require 包名`，扩展会在后台用你的 `tclsh` 加载它并学习其中的命令。

扩展识别 `.tcl`、`.tk`、`.tm`、`.test`、`.xdc`、`.sdc` 和 `.itcl`。建议打开**文件夹/工作区**而不是只打开一个文件，否则跨文件索引、项目配置和 Test Explorer 无法获得完整上下文。

---

## 2. 选择解释器

- **Tcl: Select Interpreter**（或点击状态栏）会列出 `PATH` 中的 `tclsh`，也可以手动输入路径。选择结果保存在当前工作区，同时用于 **运行、补全/自省、调试和测试**。选 *Use configured interpreter* 可清除工作区选择，回到设置 `tcl.interpreterPath`。
- 设置项：`tcl.interpreterPath`（默认 `tclsh`）、`tcl.interpreterArgs`。
- 补全和诊断所需的信息来自"自省"：扩展在后台启动一个**普通 tclsh**，向它询问有哪些命令、包和 Tk 部件。自省只在**受信任的工作区**里运行；关闭 `tcl.introspection.enabled` 后只使用内置表。
- 如果你日常用 Vivado、Quartus 之类的宿主工具运行脚本：把 `tcl.interpreterPath` 设为该宿主工具，把 `tcl.introspection.interpreterPath` 设为一个普通 `tclsh`，再在选择器里选 *Use configured interpreter*。
- 调试器需要普通 `tclsh`（不是 `wish`）。`launch.json` 里写了 `interpreter` 时，只对那份调试配置生效。

---

## 3. 编辑功能

| 功能 | 说明 |
|---|---|
| 语法高亮、括号、折叠、代码片段 | 开箱即用；`*.test` 文件也按 Tcl 处理 |
| 补全 | 命令、`$变量`、子命令（`string `、`dict `、`file ` …）、`package require` 包名、工作区和已加载包里的过程、命名空间成员、`-选项` 及其取值 |
| 签名提示与悬停 | 内置命令和子命令的说明、过程的参数列表、选项说明 |
| 跳转与引用 | 跨文件的转到定义、查找所有引用、安全的重命名符号、调用层次（来电/去电）、文档大纲 |
| 工作区符号搜索 | `Cmd/Ctrl+T`：过程、命名空间、类、方法 |
| `source` 支持 | 字面量路径可补全、可跳转；`source` 依赖关系用来区分重名过程 |
| TclOO | 跨文件索引类、继承（`superclass`/`mixin`）和方法，对象及 `my` 的补全与跳转 |
| Tk | 含 `package require Tk` 的文件里：部件命令、`-选项`及说明、选项取值、部件方法（`.btn ` 之后）、`bind` 事件、`wm`/`winfo` 子命令。数据来自你已安装的 Tk，并被缓存 |
| SQLite | 在 `sqlite3 db ...`（也包括 `set conn db`、`$conn eval`）之后，`db eval`、`db transaction`、`db onecolumn` 等方法的补全、悬停与签名提示 |
| 说明语言 | `tcl.docLanguage`：`auto`（跟随 VS Code 显示语言）、`en`、`zh`；覆盖约 100 个核心命令、约 240 个子命令（含 Tcl 9 新增如 `lremove`、`lseq`、`const`）以及 Tk 命令和选项、SQLite 方法 |

动态生成的过程名、类名、变量名和路径会被**保守处理**：不确定时不猜测，也不报错。

---

## 4. 诊断

### 4.1 内置诊断

`tcl.diagnostics.enabled` 控制总开关。会报告：`{` `"` `[` 不匹配、右花括号后多余的文字、未加花括号的 `expr`/`if`/`while` 条件（带快速修复）、工作区过程和内置命令**确定无疑**的参数个数错误、未知或有歧义的内置子命令。动态调用、参数展开 `{*}`、有歧义的定义、签名不统一的命令一律不报。

### 4.2 未定义命令警告

某个命令同时满足以下条件时才会报警，所以警告基本等于"这个名字哪里都没有"：不是内置命令，不是解释器里的命令，且这个名字在整个工作区**任何位置**都没有出现过（定义、`interp alias`、`coroutine`、注释、字符串里的提及都算"出现过"）。有拼写相近的已知命令时会给出提示，例如 `putss` → `puts`。

以下情况整个文件**不检查**（宁可漏报，不误报）：

- 文件（或它 `source` 的文件）里有 `rename`、`load`、`auto_load`、`auto_mkindex`、`auto_reset`、重定义 `unknown`、带通配符的 `namespace import`、`namespace path`、计算出来的 `proc` 名、修改 `auto_path`/`tcl::tm::path`、动态或无法解析的 `source`；
- 用了 Tk/Ttk，或 `package require` 的包没有在解释器里加载成功；
- 文件是 `.xdc`/`.sdc`，或配置的解释器不是普通 `tclsh`/`wish`（宿主工具）；
- 自省关闭、工作区未受信任、工作区索引不完整（文件太多）。

控制方式：

- `tcl.diagnostics.undefinedCommands`：`warning`（默认）或 `off`。
- `tcl.diagnostics.knownCommands`：额外认可的命令名，支持 `*`、`?` 通配符，如 `["get_*"]`。
- 在某一行或其上一行写 `# tcl-tools: ignore` 可压掉该行的警告。
- 想知道为什么当前文件没被检查：运行 **Tcl: Why Is the Undefined-Command Check Inactive?**，它会给出具体原因（例如哪个文件用了 `rename`）。

---

## 5. 项目配置文件

为宿主工具（Vivado、Quartus 等）或你自己的框架补充"扩展看不到"的命令。文件是**纯 JSON，从不被执行**，所以在未受信任的工作区也能用。

位置（两处都会读取并合并）：工作区根目录的 `.tcl-tools.json` 先读取，`.vscode/tcl-tools.json` 后读取并覆盖同名的 `commands` 或 `hosts`；`knownCommands` 会合并去重。运行 **Tcl: Create Project Config** 会在 `.vscode/tcl-tools.json` 生成起步文件；文件有 JSON schema，编辑时有提示。保存或在磁盘上修改后立即生效，格式问题会显示在“问题”面板。

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

- `knownCommands`：未定义命令检查认可的名字，支持通配符。
- `commands`：额外命令。值可以是签名字符串，也可以是 `{sig, en, zh, doc}` 对象（`doc` 在没有 `en`/`zh` 时同时用于两种语言）。命令名可带命名空间，如 `a::b::run`。这些命令会出现在补全、悬停和签名提示里，也不会被报未定义。
- `hosts`：按文件生效的表。`match` 是对**相对工作区的路径**的 glob：`**` 跨任意层级，`*` 只在一层内，`?` 一个字符；不含 `/` 的写法（如 `*.sdc`）在任何文件夹都匹配，且不区分大小写。宿主的 `commands`/`knownCommands` 只对匹配的文件生效。
- `check`（默认 `false`）：为 `true` 时，匹配的文件也做未定义命令检查，这时以"自省解释器"（`tcl.introspection.interpreterPath`，需为普通 `tclsh`）为准。**宿主表不完整时会产生误报**，建议先用 `false` 获得补全，表补齐后再打开。
- 没有写 `match` 的宿主永远不会生效，会有提示。

---

## 6. 运行

- **Run File**（`Cmd/Ctrl+F5`，或编辑器标题栏的运行按钮）会先保存当前文件，再在终端里直接启动配置的解释器；工作目录是源文件所在文件夹，每次运行使用独立的终端。未命名文件必须先保存。
- **Run Selection** 运行选中的代码；没有选择时运行光标所在行。代码写入权限受限的临时文件，磁盘上的源文件不会被改写。
- `tcl.interpreterArgs` 里的参数会放在脚本路径之前。

---

## 7. 测试

打开 VS Code 的"测试"视图，扩展会在 `*.test` 文件（`tcl.testing.filePattern`，默认 `**/*.test`）里发现 `tcltest` 用例。可以运行单个用例、单个文件或整个工作区；通过、失败、因约束跳过、耗时、错误位置、取消和输出都显示在原生测试界面里。

- **Run** 配置使用与"运行"相同的解释器，工作目录是测试文件所在文件夹；运行前会先保存文件。
- **Debug** 配置（或边栏菜单里的 *Debug Test*）在 Tcl 调试器下运行所选用例，`-setup`、`-body`、`-cleanup` 脚本里的断点会命中；结果照常显示在测试界面，失败详情出现在调试控制台。
- 只识别字面量的 `test 名称 描述 ...` 和 `::tcltest::test ...`；**动态生成名称的用例不会列出**。
- `tcl.testing.enabled` 可整体关闭；`tcl.testing.exclude` 排除目录（默认 `**/{.git,node_modules,.venv}/**`）。

---

## 8. 调试

对 `.tcl` 文件按 `F5`，或在 `launch.json` 里添加 `"type": "tcl"` 的配置：

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

启动参数：`program`（必填）、`args`、`cwd`（默认脚本所在文件夹）、`interpreter`、`interpreterArgs`、`env`、`stopOnEntry`（默认 `false`，直接运行到断点）、`console`（`integratedTerminal` 可使用 stdin；`internalConsole` 输出到调试控制台，无 stdin）。

功能：

- **断点**：普通、条件（`i == 50`）、命中次数（`10`、`>= 5`、`% 10`）和日志点（`{name}`）。
- **单步**：越过、进入、跳出、继续、暂停；被 `source` 的文件同样可调试，`source -encoding NAME file` 会按指定编码读取。
- **变量**：局部变量、命名空间变量、全局变量，以及"命令"（过程、别名、Tk 部件、TclOO 类/对象，以及 SQLite `db` 这类 C 句柄和它们的子命令）。列表、字典、数组可展开成树，值可以**直接修改**。
- 悬停与监视表达式同样可展开；调试控制台在所选栈帧里求值。
- **异常断点**：*Uncaught errors*（默认）和 *All errors (including caught)*（也会在 `catch`、`try ... on error` 处停下）。
- **Tk 程序**在脚本结束后继续运行（像 `wish`）；`-command {...}`、`bind`、`after` 回调里的断点有效，栈里显示为 `<callback>`。
- SQL 循环（`db eval {...} { body }`）和 `db transaction {...}` 的 body 里可以下断点。

原理：脚本在运行时被即时插桩（每条命令前加 `::__dbg::step 行号 文件;`，行号保持不变），一个小的 Tcl 代理通过本机套接字与 VS Code 通信。**磁盘上的文件不会被修改。**

**调试限制**

- 方括号 `[...]` 里的命令以及用字符串拼出来的代码（`eval`、`uplevel`）不会被逐条单步。
- 只有 `auto_path` 之外的文件会被插桩；调试前请先保存文件，保证行号一致。
- *All errors* 只识别 `error`、`catch` 和 `try ... on error`/`trap`，被其他机制吞掉的错误会被有意忽略。
- Tcl 8.5 里字典值显示为普通列表。

---

## 9. 设置参考

| 设置 | 默认 | 说明 |
|---|---|---|
| `tcl.interpreterPath` | `tclsh` | 默认解释器，用于运行、自省和调试 |
| `tcl.interpreterArgs` | `[]` | 放在脚本路径前的参数 |
| `tcl.introspection.enabled` | `true` | 在后台用 Tcl 学习命令、包、Tk 和 SQLite |
| `tcl.introspection.tk` | `true` | 含 Tk 的文件首次打开时探测一次 Tk（窗口立即隐藏，结果缓存） |
| `tcl.introspection.interpreterPath` | 空 | 自省和默认调试用的备用解释器，必须是普通 `tclsh`；工作区选择优先 |
| `tcl.introspection.interpreterArgs` | `[]` | 自省解释器的参数 |
| `tcl.docLanguage` | `auto` | 内置命令说明语言：`auto`、`en`、`zh`；没有译文的回退到英文 |
| `tcl.diagnostics.enabled` | `true` | 诊断总开关 |
| `tcl.diagnostics.undefinedCommands` | `warning` | `warning` 或 `off` |
| `tcl.diagnostics.knownCommands` | `[]` | 额外认可的命令名，支持 `*`、`?` |
| `tcl.testing.enabled` | `true` | 在测试视图中发现并运行 `tcltest` |
| `tcl.testing.filePattern` | `**/*.test` | 测试文件的工作区 glob |
| `tcl.testing.exclude` | `**/{.git,node_modules,.venv}/**` | 测试发现时排除的 glob |

---

## 10. 命令参考

在命令面板（`Cmd/Ctrl+Shift+P`）中输入 `Tcl`。

| 命令 | 作用 |
|---|---|
| Tcl: Run Current File | 运行当前文件（`Cmd/Ctrl+F5`） |
| Tcl: Run Selection | 运行选中代码 |
| Tcl: Select Interpreter | 选择解释器，状态栏也可点击 |
| Tcl: Refresh Introspection | 清除缓存并重新探测解释器 |
| Tcl: Why Is the Undefined-Command Check Inactive? | 说明当前文件为什么没有做未定义命令检查 |
| Tcl: Show Environment Info | 报告解释器、自省、索引、诊断和项目配置的状态，并给出建议 |
| Tcl: Get Started (Walkthrough) | 打开入门引导 |
| Tcl: Open User Guide | 以预览方式打开本指南 |
| Tcl: Open Sample File | 打开示例文件（保存在扩展存储里，改动会保留） |
| Tcl: Create Project Config | 在 `.vscode/tcl-tools.json` 生成起步文件（已存在则直接打开） |

---

## 11. 故障排查

遇到问题时，先运行 **Tcl: Show Environment Info**。它会列出当前文件使用的解释器和版本、自省是否开启与是否成功、已加载和加载失败的包、索引的文件数，以及“建议”一栏里的具体处理办法。

| 现象 | 原因与办法 |
|---|---|
| 补全里没有某个包的命令 | 文件里没有 `package require`，或该包在你的解释器里加载失败（环境信息里会列出）；确认 `tclsh` 能加载它，再运行 **Tcl: Refresh Introspection** |
| 完全没有未定义命令警告 | 运行 **Tcl: Why Is the Undefined-Command Check Inactive?**。常见原因：自省关闭、工作区未受信任、解释器不是普通 `tclsh`、文件用了 Tk 或 `rename` 等 |
| 某个合法命令被报未定义 | 把它加进 `tcl.diagnostics.knownCommands` 或项目配置的 `knownCommands`/`commands`，或在该行写 `# tcl-tools: ignore` |
| 用 Vivado/Quartus 运行，补全和诊断都不对 | 把 `tcl.introspection.interpreterPath` 设为普通 `tclsh`，用项目配置的 `commands`/`hosts` 描述宿主命令 |
| macOS 上提示没有 `lmap`/`try` | 系统 `tclsh` 是 8.5；另装 8.6+ 并在 **Tcl: Select Interpreter** 中选择 |
| 调试器启动失败 | 调试需要普通 `tclsh` 而不是 `wish`；检查 `launch.json` 的 `interpreter` 和 **Show Environment Info** 里的解释器 |
| 断点没有停下来 | 先保存文件；`[...]` 里的命令和 `eval`/`uplevel` 拼出的代码不会被单步；`auto_path` 里的文件不会被插桩 |
| 测试里看不到某个用例 | 只列出字面量名称的用例；确认文件匹配 `tcl.testing.filePattern` 且没有被 `tcl.testing.exclude` 排除 |
| 在设置界面改了设置似乎没有生效 | 检查设置写在用户、工作区还是语言作用域，并运行 **Tcl: Show Environment Info** 确认当前文件读到的值；诊断和自省设置会在修改后刷新。仍不正常时，在“输出”面板选择 **Tcl Tools** 查看日志 |
| 刚改了 `.vscode/tcl-tools.json` 没有变化 | 保存文件；格式错误会出现在"问题"面板，出错的条目被忽略。**Show Environment Info** 的"Project configuration"一栏会列出已读取的文件 |

---

## 12. 已知限制

- 过程由一个理解 Tcl 语法的小型扫描器找出（跳过注释、字符串和数据花括号）；**动态创建的过程**（`eval` 里的 `proc`、字符串拼出的名字）看不到。
- 未定义命令检查是**保守版**：宁可漏报也不误报，只检查命令位置的字，`$cmd args` 这类动态调用不检查；宿主文件需要你在项目配置里描述。
- 工作区超过 2000 个 Tcl 文件时，跨文件功能只覆盖前 2000 个，未定义命令检查会关闭。
- 调试器限制见第 8 节。
- 调试器目前只支持本地 `launch`，不支持 attach、远程调试或连接已经运行的 Tcl 进程。
- 目前没有内置的格式化、Lint 和重构（重命名除外）功能。

---

## 13. 附录：入门引导

入门引导已经实现为 VS Code Walkthrough（`contributes.walkthroughs`，文案在 `media/walkthrough/`）。界面只显示一种语言：按 VS Code 的显示语言选择中文或英文（英文文案是默认文件，中文在同名的 `*.nls.zh.md` 里；命令和引导标题在 `package.nls.json` / `package.nls.zh-cn.json`）。共 8 步，每一步配有可点击的命令：

| 步骤 | 标题 | 动作 | 内容来源 |
|---|---|---|---|
| 1 | 选择解释器 | `tcl.selectInterpreter` | 第 2 节 |
| 2 | 检查环境 | `tcl.showEnvironment` | 第 11 节 |
| 3 | 打开示例文件 | `tcl.openWalkthroughSample` | 第 3 节 |
| 4 | 运行脚本 | `tcl.runFile` | 第 6 节 |
| 5 | 运行测试 | 测试视图 | 第 7 节 |
| 6 | 调试脚本 | 开始调试 | 第 8 节 |
| 7 | 描述宿主命令（可选） | `tcl.createProjectConfig` | 第 5 节 |
| 8 | 接下来 | `tcl.showEnvironment` | 第 11 节 |

示例文件（`sample.tcl` 英文、`sample.zh.tcl` 中文，按 `tcl.docLanguage` 或显示语言选择）含一个命名空间、一个过程和一个故意拼错的命令；它在首次打开时被复制到扩展存储目录，之后不会被覆盖。修改引导时请保持示例文件里拼错的命令名只出现一次（注释里的提及会让未定义命令警告消失），测试 `test/onboarding.test.js` 会检查这一点。
