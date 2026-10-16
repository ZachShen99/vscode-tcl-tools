# introspect_handles.tcl -- usage: tclsh introspect_handles.tcl type=package=command=arg ...
# Creates one throw-away object per spec (e.g. an in-memory SQLite database) and asks it for its methods.
#   HM <type> <method> ...          method names reported by the object itself
#   HV <type> <method> <value> ...  enumerated values for a few methods
#   HE <type> <message>             the package could not be loaded
proc mustBe {msg} {
    if {![regexp {(?:must|should) be (.*)$} $msg -> tail]} { return {} }
    regsub -all {, or | or |, } [string trimright $tail .] { } tail
    set out {}
    foreach v $tail { lappend out [string trim $v ",\""] }
    return $out
}
proc emit {args} { puts [join [lmap a $args {string map [list \n { } \t { }] $a}] \t] }
foreach spec $argv {
    lassign [split $spec =] type pkg cmd arg
    if {[catch {package require $pkg} err]} { emit HE $type $err; continue }
    if {[catch {$cmd __probe__ {*}$arg} err]} { emit HE $type $err; continue }
    catch {__probe__ __no_such_method__} msg
    emit HM $type {*}[mustBe $msg]
    foreach {m extra} {transaction {{}} status {}} {
        catch {__probe__ $m __no_such_value__ {*}$extra} vmsg
        set vals {}
        foreach v [mustBe $vmsg] { if {[regexp {^[\w-]+$} $v]} { lappend vals $v } }
        if {[llength $vals]} { emit HV $type $m {*}$vals }
    }
    catch {__probe__ close}
}
