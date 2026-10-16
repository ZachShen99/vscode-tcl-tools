# 复杂变量展开测试。按 F5 调试，程序会停在第一条命令；在最后那行 puts 设断点后继续运行，停下后看"变量"面板。
# EXPECT（展开 Globals）：
#   sample_list = list(4) apple banana cherry {nested 42}      展开：[0] apple、[1] banana、[2] cherry、[3] list(2)（可继续展开）
#   user_info   = array(3)                                      展开：[age] 30、[name] Alice、[role] Developer
#   nested_dict = dict(2) user1 {...} user2 {...}               展开：user1、user2（各自再展开：name、status）
# 类型是按 Tcl 值当前的内部表示判断的：用 list 或 dict 命令创建的值能正确展开；
# 只是长得像列表的普通字符串（例如直接写 set s "a b c"）仍显示为普通字符串。

# test_data_structures.tcl - 验证复杂变量在调试面板中的展开与展示

# 1. List
set sample_list [list "apple" "banana" "cherry" [list "nested" 42]]

# 2. Array
array set user_info {
    name    "Alice"
    age     30
    role    "Developer"
}

# 3. Dict (TCL 8.5+)
set nested_dict [dict create \
    user1 [dict create name "Bob" status "active"] \
    user2 [dict create name "Charlie" status "pending"] \
]

# 在此行打断点，检查变量面板中 list, array, dict 的展开结构
puts "Data structures loaded."
