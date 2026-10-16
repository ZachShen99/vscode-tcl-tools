# 运行时自省：写了 `package require` 后，扩展会在后台 tclsh 里加载该包。
package require http
package require msgcat

# TRY: 打开文件后等约 1 秒，然后：
#   输入 `ht`                EXPECT: 列表里只有命名空间 `http::`（选中后自动继续弹出成员），不会一次展开所有成员
#   输入 `http::`            EXPECT: 成员的完整限定名 http::geturl、http::config、http::formatQuery 等，子命名空间显示为 http::cwaiter::
#                            （只有导出的 proc，不包含 BlockingGets 之类的内部函数）
#   输入 `http::geturl |`    EXPECT: `::http::geturl url args`
#   输入 `msgcat::m`         EXPECT: mc、mcset、mcmax 等
#   把鼠标悬停在下面的 geturl 上  EXPECT: 显示签名
# 输出面板 "Tcl Tools"（视图 -> 输出）应有日志：
#   introspection [http,msgcat]: N commands, M package procs
# 如果完全没有补全：先看输出面板 Tcl Tools 的日志（里面会写 tclsh 的报错），
#   注意 macOS 自带的 tclsh 是 8.5，自省脚本现在已兼容 8.5。
# 反向测试：加一行 `package require nosuchpkg` -> 日志出现 "package require nosuchpkg failed"；
#   其余功能照常工作，不会反复弹窗打扰。

set token [http::geturl http://example.invalid -timeout 10]
puts [msgcat::mc hello]
