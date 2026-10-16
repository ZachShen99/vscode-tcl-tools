# 14_catch_and_hover.tcl - "所有错误都停" 与 悬停/监视展开
#
# A. 所有错误都停：
#    调试面板 -> 断点区域 -> 勾选 "All errors (including caught)"。
#    之后每次 `error` 调用、以及被 `catch` 吞掉的错误都会停下，
#    可在"调用堆栈"旁查看异常信息（错误消息 + errorInfo）。
#    说明：`try ... on error` 里由内置命令（如 expr 1/0）引起的错误目前不会停；
#         显式 `error ...` 调用在 try 里同样会停。
# B. 悬停/监视展开：
#    停在最后一行 puts 时，把鼠标悬停在 data / cfg 上，或在"监视"里添加
#    `data`、`dict get $cfg db`、`lrange $data 1 2`，结果前有箭头可继续展开。

proc risky {x} {
    return [expr {10 / $x}]
}

catch {risky 0} msg1
catch {error "自定义错误"} msg2

set data [list 10 20 {30 40}]
set cfg [dict create name demo db [dict create host localhost port 5432]]
puts "msg1=$msg1 msg2=$msg2"
