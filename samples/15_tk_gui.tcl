# test_tk_windows.tcl - 验证多窗口管理与 Modal 模态框调试

package require Tk

wm title . "Tk Debug Test - Window Manager"
wm geometry . "300x150"

proc open_child_window {} {
    # 【断点建议】：设在此处，检查二次弹窗过程中的变量作用域
    set top [toplevel .child_win]
    wm title $top "Child Window"
    wm geometry $top "250x120"
    
    label $top.lbl -text "This is a Child Window"
    button $top.btn -text "Show Alert" -command {
        set answer [tk_messageBox -type yesno -message "Do you want to close child window?" -icon question]
        # 【断点建议】：在此处断点，检查 messageBox 返回值 answer ("yes" 或 "no")
        if {$answer eq "yes"} {
            destroy .child_win
        }
    }
    pack $top.lbl -pady 15
    pack $top.btn -pady 5
}

button .btn_open -text "Open Child Window" -command open_child_window
pack .btn_open -pady 40