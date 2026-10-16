# test_tk_basic.tcl - 验证基础 GUI 交互与回调函数调试

package require Tk

wm title . "Tk Debug Test - Basic Controls"
wm geometry . "350x200"

set click_count 0
set label_text "Button not clicked yet"

# 1. 按钮点击回调函数
proc on_button_click {} {
    global click_count label_text
    # 【断点建议】：在此处设断点，点击按钮时触发，观察变量变化
    incr click_count
    set label_text "Clicked $click_count times"
    puts "LOG: Button clicked, total = $click_count"
}

# 2. 键盘事件回调函数
proc on_key_press {event_keysym} {
    # 【断点建议】：在此处设断点，按任意键触发，检查 event_keysym 的值
    puts "LOG: Key pressed in Entry -> $event_keysym"
}

# 界面布局
label .lbl -textvariable label_text -font {Helvetica 12}
button .btn -text "Click Me!" -command on_button_click

label .lbl_input -text "Type something:"
entry .ent -width 25
bind .ent <KeyPress> { on_key_press %K }

pack .lbl -pady 10
pack .btn -pady 5
pack .lbl_input -pady {10 2}
pack .ent -pady 5

# 另外：`-command {...}`、`after 毫秒 {...}`、`bind 控件 事件 {...}` 花括号里的脚本也可以直接设断点、单步。
button .btn2 -text "Inline script" -command {
    set clicked yes
    puts "inline callback ran"
}
pack .btn2 -pady 5
