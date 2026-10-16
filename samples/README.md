# 手动测试脚本

用 VS Code 打开扩展文件夹，按 F5 启动扩展开发宿主，再在宿主窗口中打开这些文件。
文件里 `TRY:` 开头的行说明要输入或操作什么，`EXPECT:` 开头的行说明应该看到什么。

| 文件 | 测试内容 |
|---|---|
| 01_syntax.tcl | 语法高亮（对照你的主题：字符串、变量、注释、数字、选项） |
| 02_completion.tcl | 命令 / 变量 / 子命令 / 包名补全 |
| 03_signature_hover.tcl | 签名提示、悬停、当前参数高亮 |
| 04_packages.tcl | `package require` 的运行时自省（http、msgcat） |
| 05_definition.tcl + lib/mathlib.tcl | 跨文件跳转定义、大纲、命名空间 |
| 06_run.tcl | 运行文件（Cmd+F5）与运行选中内容 |
| 07_edge_cases.tcl | 不应该出错的边界情况：多行参数、注释里的大括号、绝对名称等（诊断只应有 1 条警告） |
| 12_data_structures.tcl | 调试器：list、array、dict 在变量面板里的树状展开（含嵌套） |
| 11_interactive.tcl | 调试器：集成终端里的 stdin、未捕获错误的异常断点、日志点 |
| 10_debug.tcl | 调试器：断点、单步、调用栈、变量、悬停、调试控制台求值、条件断点、跨文件单步 |
| 08_diagnostics.tcl | 诊断：3 个警告（expr 没加大括号）+ 2 个错误（else 换行、多余的 }），含快速修复 |
| 09_unbalanced.tcl | 诊断：proc 少了结尾的 }，错误应指向开头的 { |

自动化测试：`npm test`。

## 13 条件断点
`13_conditional_breakpoint.tcl`：条件可直接写 `i == 50`（变量名可省略 `$`）；支持"命中次数"（如 `10`、`>= 5`、`% 10`）和日志点 `{i}`；条件出错会在调试控制台提示。

## 14 所有错误都停 / 悬停展开
`14_catch_and_hover.tcl`：勾选 "All errors (including caught)" 后，`error` 调用与被 `catch` 吞掉的错误都会停下；悬停或监视 list/dict/array 的结果可以展开。

## 15 / 16 Tk 图形界面（16 号为参考版本，15 号可替换成你自己的脚本）
`15_tk_gui.tcl`：程序执行完后会像 `wish` 一样保持窗口并继续处理事件；在回调函数里设断点，点击按钮/按键时会停下，调用栈底部显示 `<event loop>`。关闭窗口程序结束。

在带 `package require Tk` 的文件里（见 15_tk_gui.tcl）：输入 `bu` 补全 `button`；`button .b -` 补全选项（带说明）；`-relief ` 后补全取值；`.btn ` 补全该控件的方法；`bind .ent <` 补全事件；悬停在 `-command` 等选项上看说明。

## 17 SQLite 句柄补全
`17_sqlite_completion.tcl`：`sqlite3 db ...` 创建的句柄（任意名字）在 `db ` 后补全全部子命令；`db transaction ` 补全 deferred/exclusive/immediate；输入参数时有签名提示，悬停有说明。子命令列表在打开含 `sqlite3` 的文件时从本机实际的 SQLite 探测（结果缓存，"Tcl: Refresh Introspection" 可重新探测），说明文字来自内置表；探测失败时回退到内置表。
调试时变量面板的 Commands 分组也不再列出 Tcl 自带的 `pkg_mkIndex`、`tclPkg*` 等库过程。
