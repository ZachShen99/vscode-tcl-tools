# 括号不匹配测试：下面的 proc 少了结尾的 }。
# EXPECT: 红色波浪线出现在 `proc broken {x} {` 这一行末尾那个 { 上，
#         提示 Unmatched "{": the closing brace is missing；整个文件只有这 1 条诊断。
# TRY: 在文件末尾补上一个 } -> 波浪线消失。
# 其他需要单独试的写法（在文件末尾新建一行输入，试完删除）：
#   puts "abc          -> 提示引号没闭合
#   puts [string length x     -> 提示 [ 没闭合
#   puts {a}b          -> 提示闭合大括号后还有多余字符

proc broken {x} {
    puts $x
    if {$x > 0} {
        puts positive
    }
