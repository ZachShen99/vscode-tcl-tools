# introspect_tk.tcl -- usage: tclsh introspect_tk.tcl
# Loads Tk (window withdrawn at once) and prints tab-separated records:
#   TK <version>
#   C <command>                 commands Tk added to the global namespace
#   W <class> <option>...       options accepted by `class .w` (from `.w configure`)
#   M <class> <method>...       widget instance methods (from the "must be ..." error of a bogus method)
#   S <command> <sub>...        subcommands of wm, winfo, ...
#   V <class> <option> <v>...   enumerated option values (from the error of a bogus value)
namespace eval ::__tkprobe {
    proc emit {kind args} {
        set f [list $kind]
        foreach a $args { lappend f [string map [list \n { } \t { }] $a] }
        puts [join $f \t]
    }
    # "bad option "x": must be a, b, or c"  ->  {a b c}
    proc mustBe {msg} {
        if {![regexp {must be (.*)$} $msg -> tail]} { return {} }
        set tail [string trimright $tail .]
        regsub -all {,? or } $tail {, } tail
        set out {}
        foreach v [split $tail ,] { set v [string trim $v]; if {$v ne ""} { lappend out $v } }
        return $out
    }
    proc main {} {
        set before [info commands]
        if {[catch {package require Tk} err]} { emit E Tk $err; return }
        catch {wm withdraw .}
        emit TK $::tk_version
        foreach c [lsort [info commands]] {
            if {[lsearch -exact $before $c] < 0 && [regexp {^[A-Za-z_]} $c] && ![string match auto_* $c]} { emit C $c }
        }
        foreach c [lsort [info commands ttk::*]] { emit C $c }

        # widgets
        set classes {button label checkbutton radiobutton entry spinbox text listbox scale scrollbar frame
            labelframe toplevel canvas menu menubutton message panedwindow}
        foreach t {button checkbutton radiobutton menubutton label entry combobox frame labelframe notebook
            panedwindow progressbar scale scrollbar separator sizegrip spinbox treeview} {
            lappend classes ttk::$t
        }
        set n 0
        foreach cls $classes {
            if {![llength [info commands ::$cls]]} continue
            set w .__probe[incr n]
            if {[catch {$cls $w} e]} continue
            if {[catch {$w configure} cfg]} { destroy $w; continue }
            set opts {}
            foreach item $cfg { lappend opts [lindex $item 0] }
            emit W $cls {*}$opts
            if {[catch {$w __nosuchmethod__} msg]} {
                set m [mustBe $msg]
                if {[llength $m]} { emit M $cls {*}$m }
            }
            foreach o $opts {
                if {[catch {$w configure $o __nosuchvalue__} msg]} {
                    set v [mustBe $msg]
                    if {[llength $v] >= 2 && [string first __nosuchvalue__ $msg] >= 0} { emit V $cls $o {*}$v }
                }
            }
            destroy $w
        }

        # subcommands
        foreach c {wm winfo tk tkwait clipboard grab event grid pack place image font option selection focus} {
            foreach probe [list [list $c __nosuch__] [list $c __nosuch__ .]] {
                if {[catch $probe msg]} {
                    set s [mustBe $msg]
                    if {[llength $s]} { emit S $c {*}$s; break }
                }
            }
        }
        # geometry option values
        frame .__g
        frame .__g.c
        foreach {cmd opt} {pack -side pack -fill pack -anchor} {
            if {[catch {$cmd .__g.c $opt __nosuchvalue__} msg]} {
                set v [mustBe $msg]
                if {[llength $v] >= 2} { emit V $cmd $opt {*}$v }
            }
        }
        destroy .__g
    }
}
catch {::__tkprobe::main}
catch {destroy .}
exit
