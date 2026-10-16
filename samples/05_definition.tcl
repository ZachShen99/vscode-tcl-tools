source [file join [file dirname [info script]] lib mathlib.tcl]

# TRY: 对下面每个名字按 F12 或 Cmd+点击。
puts [mathlib::gcd 12 18]     ;# EXPECT: 跳到 lib/mathlib.tcl（工作区需包含 samples 或其上级目录）
puts [mathlib::lcm 4 6]       ;# EXPECT: 跳到 lcm
puts [clamp 15 0 10]          ;# EXPECT: 跳到 clamp
puts [local_helper 3]         ;# EXPECT: 跳到本文件下面那个 proc

proc local_helper {x} { expr {$x * $x} }

# TRY: 打开大纲视图（或 Cmd+Shift+O）  EXPECT: 列出 local_helper
# TRY: 打开 lib/mathlib.tcl 看它的大纲  EXPECT: 命名空间 mathlib（其下是 gcd、lcm），以及顶层的 clamp
# TRY: 悬停在上面调用里的 gcd 上  EXPECT: 签名 `::mathlib::gcd a b`，以及 "两个整数的最大公约数。" 文档
