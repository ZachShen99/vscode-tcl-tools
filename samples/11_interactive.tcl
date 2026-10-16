# 交互式调试测试：程序要从键盘读输入，所以调试时它运行在 VS Code 的集成终端里（launch 配置里 console 默认就是这个）。
# 按 F5 调试本文件。试下面几步：
#   1. 程序在终端里提示输入一个整数，直接在终端里输入并回车（stdin 正常工作）。
#   2. 输入 abc 这样的非数字：expr 会报错，因为勾选了"未捕获的错误"异常断点（默认勾选），
#      程序会停在出错的那一行，编辑器里弹出异常信息；变量面板里能看到全局变量 line 和 n。
#      在调试面板左下角的"断点"区域取消勾选"Uncaught errors"后再试，程序会直接报错退出。
#   3. 日志点：在 puts 平方 那一行的行号处右键，选"添加日志点"，内容填 n={n} 平方={$n * $n}，
#      运行时调试控制台会打印出来，但程序不会停下。
#   4. 在 square 里的 return 那一行设断点，单步看 x 的值。
# EXPECT: 输入 7 时，终端输出 平方 = 49 和 结束。

puts -nonewline "请输入一个整数: "
flush stdout
gets stdin line
set n [string trim $line]

proc square {x} {
    return [expr {$x * $x}]
}

puts "平方 = [square $n]"
if {$n < 0} {
    puts "这是一个负数"
}
puts "结束"
