# 13_conditional_breakpoint.tcl - 条件断点 / 命中次数 / 日志点
#
# 1. 在下面标 <== 的那一行设置断点，右键断点 -> 编辑断点：
#    - 表达式：i == 50   （也可以写 $i == 50）  -> 只在 i 为 50 时停下，target 应为 2550
#    - 命中次数：10      -> 第 10 次执行该行时停下（此时 i = 9）
#    - 日志消息：i={i} target={target}  -> 不停下，只在调试控制台输出
# 2. 条件写错时（例如语法错误），调试控制台会提示 "Breakpoint condition error"。

set target 0

for {set i 0} {$i < 100} {incr i} {
    set target [expr {$target + ($i * 2)}]
    puts "Iteration $i: target = $target"   ;# <== 在这里设置断点
}

puts "Loop completed with target = $target"
