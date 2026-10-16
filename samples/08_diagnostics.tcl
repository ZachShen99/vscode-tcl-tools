# 诊断测试：本文件故意包含 3 个警告和 2 个错误，其余代码不应有波浪线。
# 打开后看"问题"面板，应该恰好 5 条。

set a 1
set b 2
set i 0
set flag 1

# --- 不应该有任何提示的写法（对照组） ---
set ok1 [expr {$a + $b}]
set ok2 [expr $a]            ;# 单个纯变量不报警
if $flag { puts "flag ok" }  ;# `if $flag` 这种惯用写法不报警
expr 1 + 2                   ;# 没有 $ 和 [] 的表达式不报警

# --- 3 个警告（黄色）：表达式没加大括号 ---
set r1 [expr $a + $b]                       ;# 警告 1：多个参数拼成表达式
if {$flag} { set r2 [expr $a * 2] }         ;# 警告 2：嵌套在 if 的 body 里也能检查到
while "$i < 3" { incr i }                   ;# 警告 3：条件用引号包起来
# TRY: 把光标放在警告 1 上，按 Cmd+.（快速修复）-> "Wrap expression in braces"
#      EXPECT: 变成 [expr {$a + $b}]
# TRY: 对警告 3 同样操作  EXPECT: 变成 while {$i < 3} { incr i }

# --- 2 个错误（红色）；注意注释里不要写大括号，Tcl 会把它们计入 ---
if {$a > 0} {
    puts positive
}
else {                                      ;# 错误 1：else 必须和上一个右大括号在同一行
    puts negative
}

proc tail {} { return 1 }
}                                           ;# 错误 2：多余的右大括号
