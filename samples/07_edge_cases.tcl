# 边界情况：下面的内容都不应该破坏高亮、大纲或补全。

# 1. 多行 proc 参数
proc multi_line {
    first
    {second 2}
    args
} {
    return $first
}
# EXPECT: 大纲里有 multi_line；输入 `multi_line 1 |` -> 高亮 `?second?`

# 2. 命名空间内的绝对 proc 名
namespace eval outer {
    proc ::global_from_ns {x} { return $x }
    proc inner_proc {y} { return $y }
}
# EXPECT: 大纲里 outer 下有两项：`::global_from_ns`（详情显示 ::global_from_ns）和 `inner_proc`（详情显示 ::outer::inner_proc）

# 3. 嵌套命名空间
namespace eval a { namespace eval b { proc deep {} {} } }
# EXPECT: 大纲是树状：a > b > deep（deep 的详情显示 ::a::b::deep）

# 4. 注释里的大括号（Tcl 也会计数，所以必须成对）
proc commented {x} {
    # 注释中的大括号 Tcl 同样会计数，所以要保持成对: { }
    return $x
}

# 5. 字符串里的关键字和方括号应保持字符串颜色
puts "proc fake {x} { if while foreach } [not a command]"

# 6. 不常见的变量写法
set {weird name} 1
puts ${weird name}
array set cfg {a 1 b 2}
puts $cfg(a)$cfg(b)

# 7. 没加大括号的 expr
set slow [expr $cfg(a) + 1]
# EXPECT: 这一行有 1 条黄色警告；快速修复（Cmd+.）后变成 [expr {$cfg(a) + 1}]；本文件其余部分没有任何诊断

# 8. 代码片段：依次输入下面每个前缀再按 Tab
#    proc  if  ifelse  for  foreach  while  switch  catch  try  nseval  dictfor  pkg  puts  main
