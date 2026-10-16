# Machine-readable tcltest adapter used by the VS Code Test Explorer.
# Compatible with Tcl/tcltest 8.5+ and intentionally kept dependency-free.
if {[llength $argv] < 1} {
    puts stderr "@@TCLTOOLS_TEST@@\terror\t\t0\t62616420617267756d656e7473"
    exit 2
}

set testFile [file normalize [lindex $argv 0]]
set selected [lrange $argv 1 end]

proc ::tcltoolsHex {value} {
    binary scan [encoding convertto utf-8 $value] H* encoded
    return $encoded
}

# TCLTOOLS_TEST_EVENTS (used by Debug Test) sends the records to a file so the debug console stays readable.
proc ::tcltoolsEmit {kind name duration {message ""}} {
    # the debugger instruments test bodies; do not let that noise reach failure messages
    regsub -all {::__dbg::step [0-9]+ [0-9]+; } $message "" message
    if {[info exists ::env(TCLTOOLS_TEST_EVENTS)] && $::env(TCLTOOLS_TEST_EVENTS) ne ""} {
        if {![catch {open $::env(TCLTOOLS_TEST_EVENTS) a} fh]} {
            fconfigure $fh -translation lf
            puts $fh "@@TCLTOOLS_TEST@@\t$kind\t[::tcltoolsHex $name]\t$duration\t[::tcltoolsHex $message]"
            close $fh
            return
        }
    }
    puts stderr "@@TCLTOOLS_TEST@@\t$kind\t[::tcltoolsHex $name]\t$duration\t[::tcltoolsHex $message]"
    flush stderr
}

if {[catch {package require tcltest} packageMessage]} {
    ::tcltoolsEmit error "" 0 $packageMessage
    exit 2
}

namespace eval ::tcltest {
    variable tcltoolsSelected $::selected
    rename test __tcltoolsOriginalTest
    proc test {name description args} {
        variable tcltoolsSelected
        variable numTests
        if {[llength $tcltoolsSelected] && [lsearch -exact $tcltoolsSelected $name] < 0} {
            return
        }
        foreach key {Total Passed Skipped Failed} {
            set before($key) $numTests($key)
        }
        set started [clock milliseconds]
        set code [catch {uplevel 1 [list ::tcltest::__tcltoolsOriginalTest $name $description {*}$args]} result options]
        set duration [expr {[clock milliseconds] - $started}]
        if {$code} {
            ::tcltoolsEmit failed $name $duration $result
            return -options $options $result
        }
        if {$numTests(Passed) > $before(Passed)} {
            ::tcltoolsEmit passed $name $duration
        } elseif {$numTests(Skipped) > $before(Skipped)} {
            ::tcltoolsEmit skipped $name $duration
        } elseif {$numTests(Failed) > $before(Failed)} {
            ::tcltoolsEmit failed $name $duration
        }
        return $result
    }
}

namespace import ::tcltest::test
catch {::tcltest::configure -verbose bps}
set sourceCode [catch {source $testFile} sourceMessage sourceOptions]
if {$sourceCode} {
    set detail $sourceMessage
    if {[dict exists $sourceOptions -errorinfo]} { set detail [dict get $sourceOptions -errorinfo] }
    ::tcltoolsEmit error "" 0 $detail
    exit 2
}
exit 0
