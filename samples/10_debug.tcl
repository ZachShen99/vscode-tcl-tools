# 调试器测试：按 F5 调试本文件（第一次选择 Tcl 调试配置）。
# 默认会在第一条命令处停下（stopOnEntry）。依次试：
#   1. F10 单步跳过，F11 单步进入（进入 fib 会出现新的调用栈帧 fib 3），Shift+F11 单步跳出，F5 继续。
#   2. 左侧行号处点击设置断点（红点），例如 foreach 里面 set f 那一行；然后继续运行，应在该行停下。
#   3. 停下后看左侧"变量"面板：Locals 是当前帧的局部变量，Globals 是全局变量（stats 是数组，可以展开）。
#   4. 把鼠标悬停在变量名上应显示它的值。
#   5. 在调试控制台输入 expr 加花括号的表达式，或者直接输入变量名，会在当前帧里求值。
#   6. 条件断点：在 fib 里 return n 那一行右键，选"编辑断点"，条件填 $n == 1，继续运行，只会在 n 等于 1 时停下。
#   7. 单步进入 mathlib 的 gcd：应跳进 lib 目录下的 mathlib.tcl，调用栈里显示 ::mathlib::gcd 48 18。
# EXPECT: 程序结束后调试控制台输出 fib(3)=2、fib(5)=5、fib(8)=21、gcd=6 和 stats。

source [file join [file dirname [info script]] lib mathlib.tcl]

proc fib {n} {
    if {$n < 2} {
        return $n
    }
    return [expr {[fib [expr {$n - 1}]] + [fib [expr {$n - 2}]]}]
}

set results {}
foreach n {3 5 8} {
    set f [fib $n]
    lappend results $f
    puts "fib($n) = $f"
}

array set stats {count 0 sum 0}
foreach r $results {
    incr stats(count)
    incr stats(sum) $r
}

puts "gcd = [mathlib::gcd 48 18]"
puts "stats: [array get stats]"
