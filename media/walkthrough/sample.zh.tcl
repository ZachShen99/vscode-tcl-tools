# Tcl Tools 示例文件
# 在这个文件上试试补全、悬停、诊断、运行和调试。

namespace eval geometry {
    proc area {w h} {
        return [expr {$w * $h}]
    }
}

proc greet {name} {
    puts "Hello, $name!"
}

greet "Tcl"
puts [geometry::area 3 4]

# 1. 在下面新起一行输入 geometry:: ，看补全列表。
# 2. 把鼠标悬停在 puts 或 geometry::area 上。
# 3. 下一行故意拼错了命令；开启自省后会出现警告。
putss "oops"

# 4. 在上面某行的行号左侧点一下设断点，然后按 F5。
