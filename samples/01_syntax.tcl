#!/usr/bin/env tclsh
# EXPECT: 第 1 行是 shebang（按注释着色）；所有以 # 开头的行都是注释颜色。

set name "Tcl"                      ;# 分号之后的行尾注释 -> 注释颜色
puts "Hello, $name! ${name}s \t é \x41 [string length $name]"   ;# 字符串内的变量、转义、方括号
set arr(key) 1
puts $arr(key)
puts $::env(HOME)
puts $::tcl_platform(os)

# 数字：42 3.14 1e10 0x1F 0b101 0o17      EXPECT: 下面代码里的数字都是数字颜色
set n [expr {42 + 3.14 * 1e10 - 0x1F + 0b101}]

# 关键字与内置命令：流程控制和内置命令应使用不同颜色
if {$n > 0} {
    puts positive
} elseif {$n == 0} {
    puts zero
} else {
    puts negative
}
for {set i 0} {$i < 3} {incr i} { continue }
while {[incr i -1] > 0} { break }
foreach {k v} {a 1 b 2} { puts "$k=$v" }
switch -glob -- $name {
    T*      { puts starts-with-T }
    default { puts other }
}
catch {error boom} msg opts
try { error x } on error {m o} { puts $m } finally { puts done }

# 定义：proc 名和 namespace 名使用 "entity" 颜色
proc greet {who {greeting Hello}} { return "$greeting, $who" }
namespace eval ::my::ns { variable counter 0 }
puts [greet World]
puts [lmap x {1 2 3} {expr {$x * 2}}]
puts [dict get [dict create a 1] a]
puts [string map {a b} abc]
# TRY: 把鼠标悬停在 greet 上 -> 显示签名；上面的 -glob 和 -- 应是选项颜色。
