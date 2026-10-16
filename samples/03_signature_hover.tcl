# 带选项的连接函数。
proc connect {host {port 80} {timeout 30} args} { return "$host:$port" }
# 两数相加。
proc sum {a b} { expr {$a + $b} }

# TRY（| 表示光标位置）：
#   `sum 1 |`                    EXPECT: 签名 `sum a b`，高亮参数 `b`
#   `connect example.com |`      EXPECT: `connect host ?port? ?timeout? args`，高亮 `?port?`
#   `connect h 1 2 3 4 |`        EXPECT: 高亮停留在 `args`
#   `set x |`                    EXPECT: `set varName ?newValue?`，高亮 `?newValue?`
#   `string map {a b} |`         EXPECT: `string map ?-nocase? mapping string`，高亮 `string`（自动跳过 flag）
#   `string compare -nocase |`   EXPECT: 高亮移动到 string1（flag 之后）
#   `puts [string length |`      EXPECT: 显示 `string length` 的签名（内层命令，不是 puts）
#   `if {$a > |`                 EXPECT: `if expr1 ?then? body1 ...`，高亮第一个参数
#   `foo 1; sum |`               EXPECT: `sum a b`（分号之后的命令）
#   `string |`                   EXPECT: `string subcommand ?arg ...?`（先选子命令，补全列表同时给出子命令）
#   `nosuchcmd 1 |`              EXPECT: 不弹出任何提示
# 悬停测试（鼠标依次移到下面每个词上）：
puts [sum 1 2]                   ;# 悬停 sum -> 代码块签名 + "两数相加。"
puts [string tolower ABC]        ;# 悬停 tolower -> 子命令签名；悬停 string -> `string subcommand ?arg ...?` 并列出全部子命令
puts [connect localhost]         ;# 悬停 connect -> 签名和文档
set y 5                          ;# 悬停 set -> 内置命令签名
