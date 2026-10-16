# introspect.tcl -- usage: tclsh introspect.tcl ?package ...?
# Prints tab-separated records describing the interpreter:
#   K <package>            known package names
#   E <package> <message>  package require failed
#   C <command>            commands visible in the global namespace (after loading packages)
#   P <fqname> <arglist>   procs defined by the requested packages (Tcl list of {name ?default?})
#   N <fqname>             every command (proc or native) the requested packages added inside a namespace
namespace eval ::__introspect {
    proc walk {ns} {
        set pat [expr {$ns eq "::" ? "::*" : "${ns}::*"}]
        set out [info procs $pat]
        foreach c [namespace children $ns] {
            if {$c eq "::__introspect"} continue
            lappend out {*}[walk $c]
        }
        return $out
    }
    # every command (procs and C commands) in a namespace tree, fully qualified
    proc walkCmds {ns} {
        set out [info commands [expr {$ns eq "::" ? "::*" : "${ns}::*"}]]
        foreach c [namespace children $ns] {
            if {$c eq "::__introspect"} continue
            lappend out {*}[walkCmds $c]
        }
        return $out
    }
    proc sig {p} {
        set spec {}
        if {[catch {info args $p} names]} { return {} }
        foreach a $names {
            if {[info default $p $a d]} { lappend spec [list $a $d] } else { lappend spec $a }
        }
        return $spec
    }
    # Public = matches the namespace's export patterns; namespaces exporting nothing keep all procs.
    proc public {p} {
        set ns [namespace qualifiers $p]
        if {$ns eq ""} { return 1 }
        set pats [namespace eval $ns {namespace export}]
        if {![llength $pats]} { return 1 }
        set tail [namespace tail $p]
        foreach pat $pats { if {[string match $pat $tail]} { return 1 } }
        return 0
    }
    proc emit {kind args} {
        set fields [list $kind]
        foreach a $args { lappend fields [string map [list \n { } \t { }] $a] }
        puts [join $fields \t]
    }
    variable tkCommands {
        bell bind bindtags button canvas checkbutton clipboard destroy entry event focus font frame grab grid
        image label labelframe listbox lower menu menubutton message option pack panedwindow place radiobutton
        raise scale scrollbar selection spinbox text tk tk_chooseColor tk_chooseDirectory tk_getOpenFile
        tk_getSaveFile tk_messageBox tk_popup tkwait toplevel winfo wm
        ttk::button ttk::checkbutton ttk::combobox ttk::entry ttk::frame ttk::label ttk::labelframe
        ttk::notebook ttk::panedwindow ttk::progressbar ttk::radiobutton ttk::scale ttk::scrollbar
        ttk::separator ttk::sizegrip ttk::spinbox ttk::style ttk::treeview
    }
    proc main {argv} {
        # Make Tcl define its lazily-loaded library procs (package machinery, pkg_mkIndex) first,
        # so they count as "already there" and are not reported as package procs.
        catch {package require __introspect_nonexistent__}
        catch {auto_load pkg_mkIndex}
        set before [dict create]
        foreach p [walk ::] { dict set before $p 1 }
        set beforeCmds [dict create]
        foreach c [walkCmds ::] { dict set beforeCmds $c 1 }
        foreach k [lsort [package names]] { emit K $k }
        set extra {}
        foreach pkg $argv {
            # Loading Tk would open a real window (and a Dock icon on macOS), so its commands are listed statically.
            if {[string equal -nocase $pkg Tk]} {
                lappend extra {*}$::__introspect::tkCommands
                continue
            }
            if {[catch {package require $pkg} err]} { emit E $pkg $err }
        }
        # global commands only: a plain [info commands] here would also list this script's own helper procs
        foreach c [lsort -unique [concat [uplevel #0 {info commands}] $extra]] { emit C $c }
        foreach p [lsort [walk ::]] {
            if {![dict exists $before $p] && [public $p]} { emit P $p [sig $p] }
        }
        foreach c [lsort [walkCmds ::]] {
            if {![dict exists $beforeCmds $c] && [namespace qualifiers $c] ne ""} { emit N $c }
        }
    }
}
::__introspect::main $argv
