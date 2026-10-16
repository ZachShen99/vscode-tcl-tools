# 运行文件（Cmd/Ctrl+F5）与运行选中内容。
# EXPECT（运行文件）："Tcl" 终端依次打印下面各行，运行结束后提示符返回。
puts "tcl [info patchlevel] on $tcl_platform(os)"
puts "script: [info script]"
puts "args: $argv"
set total 0
foreach n {1 2 3 4 5} { incr total $n }
puts "sum 1..5 = $total"            ;# EXPECT: 15
if {[catch {expr {1/0}} err]} { puts "caught: $err" }   ;# EXPECT: caught: divide by zero

# TRY 运行选中内容：只选中下面两行，执行 "Tcl: Run Selection" -> 打印 7
set a 3
puts [expr {$a + 4}]

# TRY 没有选中内容时运行：只会运行光标所在行 -> 把光标放在下一行再运行
puts "single line"

# TRY 错误路径：取消下一行注释后运行文件 -> 终端出现 Tcl 错误和调用栈
# error "intentional failure"
