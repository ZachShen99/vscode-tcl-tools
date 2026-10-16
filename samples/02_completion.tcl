# 准备：定义一些 proc 和变量，供补全查找 ------------------------

# 计算矩形面积。
proc rect_area {width height} { expr {$width * $height} }
# 礼貌地问候某人。
proc greet_user {name {punct !}} { return "Hello, $name$punct" }

set total_count 0
set user_name "zach"
foreach {key value} {a 1} {}

# 试验区：在新的一行输入下面每条内容（试完请删除） -------------
# TRY: 输入 `rect`            EXPECT: 列表中出现 rect_area（带签名和文档）
# TRY: 输入 `gre`             EXPECT: 出现 greet_user；`global` 和 `glob` 也会出现
# TRY: 输入 `puts $tot`       EXPECT: total_count
# TRY: 输入 `puts $ke`        EXPECT: key（来自 foreach），不应出现 total_count
# TRY: 输入 `string `         EXPECT: 子命令列表，包括 compare、equal、map、tolower 等
# TRY: 输入 `set x [dict `    EXPECT: dict 的子命令（在 [ ] 内部同样生效）
# TRY: 输入 `file ex`         EXPECT: exists、executable
# TRY: 输入 `package require ht`   EXPECT: http（自省完成之后）
# TRY: 输入 `puts` 再按空格   EXPECT: 不弹出补全（参数位置输入空格后保持安静）
# TRY: 输入 `info `           EXPECT: args body commands exists level procs 等
# TRY: 输入 `pars`            EXPECT: parray（来自 tclsh 的运行时命令；自省正常时才有）
# TRY: 命令面板 -> "Tcl: Refresh Introspection"   EXPECT: 弹出提示，显示命令数量
