# agent.tcl -- Tcl side of the debugger.  usage: tclsh agent.tcl port program ?arg ...?
# Talks to the VS Code debug adapter over a TCP socket. Messages are single lines of tab-separated
# fields; inside a field, backslash, newline, tab and CR are escaped as \\ \n \t \r.
# Works with Tcl 8.5+ (no 8.6-only commands).
namespace eval ::__dbg {
    variable sock ""
    variable files
    variable bp
    variable bpLines
    variable last
    array set files {}
    array set bp {}
    array set bpLines {}
    variable hits
    array set hits {}
    variable condErr
    array set condErr {}
    array set last {}
    variable maxLevel 0
    variable mode run
    variable stepLevel 0
    variable pauseReq 0
    variable inEval 0
    variable entryPending 0
    variable stopOnUncaught 0
    variable stopOnAll 0
    variable baseCmds
    array set baseCmds {}
    variable reportedMsg ""
    variable seenKey ""
    variable inLoop 0
    variable held
    array set held {}
    variable uncaughtLoc {}

    proc esc {s} { string map [list "\\" "\\\\" "\n" "\\n" "\t" "\\t" "\r" "\\r"] $s }
    proc unesc {s} { string map [list "\\\\" "\\" "\\n" "\n" "\\t" "\t" "\\r" "\r"] $s }

    proc send {args} {
        variable sock
        set fields {}
        foreach a $args { lappend fields [esc $a] }
        puts $sock [join $fields "\t"]
        flush $sock
    }
    proc decode {line} {
        set out {}
        foreach f [split $line "\t"] { lappend out [unesc $f] }
        return $out
    }
    proc trunc {s} {
        # `string length` would turn the caller's list/dict/int into a plain string (dropping its internal
        # representation, which the debugger and the program both rely on), so work on a private copy.
        set c ""
        append c $s
        if {[string length $c] > 300} { return "[string range $c 0 299]..." }
        return $c
    }

    # ---- breakpoints ----
    proc setBreakpoints {msg} {
        variable bp
        variable bpLines
        variable hits
        variable condErr
        set path [lindex $msg 1]
        set n [lindex $msg 2]
        if {[info exists bpLines($path)]} {
            foreach l $bpLines($path) { unset -nocomplain bp($path,$l) }
        }
        set lines {}
        for {set i 0} {$i < $n} {incr i} {
            set line [lindex $msg [expr {3 + 4 * $i}]]
            set cond [lindex $msg [expr {4 + 4 * $i}]]
            set logmsg [lindex $msg [expr {5 + 4 * $i}]]
            set hit [lindex $msg [expr {6 + 4 * $i}]]
            set bp($path,$line) [list $cond $logmsg $hit]
            set hits($path,$line) 0
            unset -nocomplain condErr($path,$line)
            lappend lines $line
        }
        set bpLines($path) $lines
    }
    # Lets conditions be written without "$": bare words that name a variable in the frame get "$" added.
    proc autoVars {lvl expr} {
        set out ""
        set rest $expr
        while {$rest ne ""} {
            set c [string index $rest 0]
            if {$c eq "\""} {
                if {![regexp {^"(?:[^"\\]|\\.)*"?} $rest m]} { set m $c }
            } elseif {$c eq "\$"} {
                if {![regexp {^\$(?:\{[^\}]*\}|[A-Za-z0-9_:]+(?:\([^)]*\))?)} $rest m]} { set m $c }
            } elseif {[regexp {^[0-9][0-9A-Za-z_.]*} $rest m]} {
            } elseif {[regexp {^[A-Za-z_][A-Za-z0-9_]*} $rest m]} {
                set after [string range $rest [string length $m] end]
                if {[string index $after 0] ne "(" && $m ni {eq ne in ni true false yes no on off} &&
                    ![catch {uplevel #$lvl [list info exists $m]} ex] && $ex &&
                    ![catch {uplevel #$lvl [list array exists $m]} ar] && !$ar} {
                    append out "\$\{" $m "\}"
                    set rest $after
                    continue
                }
            } else {
                set m $c
            }
            append out $m
            set rest [string range $rest [string length $m] end]
        }
        return $out
    }
    proc evalExpr {lvl expr} {
        if {![catch {uplevel #$lvl [list expr [autoVars $lvl $expr]]} res opts]} { return [list 0 $res] }
        return [list 1 $res]
    }
    proc hitOk {n spec} {
        set spec [string trim $spec]
        if {$spec eq ""} { return 1 }
        if {[string is integer -strict $spec]} { return [expr {$n == $spec}] }
        if {[regexp {^(==|>=|<=|>|<|%)\s*([0-9]+)$} $spec -> op v]} {
            if {$op eq "%"} { return [expr {$v > 0 && $n % $v == 0}] }
            return [expr "\$n $op \$v"]
        }
        return 1
    }
    proc condOk {lvl cond key} {
        variable inEval
        variable condErr
        if {$cond eq ""} { return 1 }
        set inEval 1
        lassign [evalExpr $lvl $cond] rc res
        set inEval 0
        if {$rc} {
            if {![info exists condErr($key)]} {
                set condErr($key) 1
                send log "Breakpoint condition error ($key): $res (condition: $cond)"
            }
            return 0
        }
        return [expr {[string is true -strict $res] ? 1 : 0}]
    }

    # Logpoint text: every {expr} is replaced by the value of that variable or expression in the frame.
    proc formatLog {lvl msg} {
        variable inEval
        set out ""
        set inEval 1
        while {[regexp -indices {\{([^{}]*)\}} $msg all inner]} {
            lassign $all a b
            lassign $inner x y
            set piece [string range $msg $x $y]
            append out [string range $msg 0 [expr {$a - 1}]]
            if {[regexp {^\$?([A-Za-z_][A-Za-z0-9_:]*)(\(.*\))?$} $piece -> name idx] &&
                ![catch {uplevel #$lvl [list set "$name$idx"]} val]} {
                append out $val
            } else {
                lassign [evalExpr $lvl $piece] erc val
                if {!$erc} { append out $val } else { append out "<error: $val>" }
            }
            set msg [string range $msg [expr {$b + 1}] end]
        }
        set inEval 0
        return "$out$msg"
    }

    # ---- inspection requests (valid while stopped) ----
    proc doStack {id lvl} {
        variable last
        variable inLoop
        variable uncaughtLoc
        if {[llength $uncaughtLoc]} {
            lassign $uncaughtLoc path line
            send stack $id 1 "<uncaught error>" $path $line
            return
        }
        set flat {}
        set count 0
        for {set i $lvl} {$i >= 0} {incr i -1} {
            if {$i == 0 && $inLoop} {
                if {$lvl == 0 && [info exists last(0)]} {
                    # stopped inside a global-level callback script (e.g. `button -command {...}`): show its line
                    lassign $last(0) path line
                    lappend flat "<callback>" $path $line
                } else {
                    lappend flat "<event loop>" "" 0
                }
                incr count
                continue
            }
            if {$i == 0} {
                set name "<global>"
            } elseif {[catch {info level $i} cmd]} {
                set name "frame $i"
            } else {
                set name [string trim "[lindex $cmd 0] [lrange $cmd 1 end]"]
                if {[string length $name] > 60} { set name "[string range $name 0 56]..." }
            }
            set path ""
            set line 0
            if {[info exists last($i)]} { lassign $last($i) path line }
            lappend flat $name $path $line
            incr count
        }
        send stack $id $count {*}$flat
    }
    proc skipGlobal {v} {
        if {[string match tcl_* $v] || [string match auto_* $v]} { return 1 }
        expr {[lsearch -exact {env errorCode errorInfo} $v] >= 0}
    }
    # ---- value kinds: list / dict / scalar ----
    # Tcl has no static types; the internal representation tells what a value currently is. Ask for it
    # *before* touching the value (calling `dict size` on a list or `llength` on a dict converts it).
    proc kindOf {val} {
        if {![catch {::tcl::unsupported::representation $val} rep]} {
            if {[regexp {^value is an? ([^ ]+)} $rep -> k]} {
                if {$k eq "list" || $k eq "dict"} { return $k }
            }
            return scalar
        }
        # Tcl 8.5 has no way to tell a list from a dict: show anything list-shaped as a list (a dict then
        # appears as alternating key/value elements) instead of guessing wrong.
        if {[string is list -strict $val] && [llength $val] > 1} { return list }
        return scalar
    }
    # -> {type summary hasChildren} for any value
    proc describe {val} {
        switch -- [kindOf $val] {
            list { set n [llength $val]; return [list list "list($n) [trunc $val]" [expr {$n > 0}]] }
            dict { set n [dict size $val]; return [list dict "dict($n) [trunc $val]" [expr {$n > 0}]] }
        }
        return [list scalar [trunc $val] 0]
    }
    # A path is a Tcl list: {root step ...}; root = {var NAME} | {arr NAME KEY}; step = {idx N} | {key K}.
    # -> {array NAME} | {value VAL}
    proc resolve {L path} {
        lassign [lindex $path 0] rk name key
        if {$rk eq "held"} {
            variable held
            set ref ""
            set val $held($name)
        } elseif {$rk eq "var"} {
            if {[uplevel #$L [list array exists $name]]} { return [list array $name] }
            set ref $name
        } else {
            set ref "${name}($key)"
        }
        if {$ref ne "" && [catch {uplevel #$L [list set $ref]} val]} { return [list value "<unset>"] }
        foreach step [lrange $path 1 end] {
            lassign $step sk sv
            if {$sk eq "idx"} { set val [lindex $val $sv] } else { set val [dict get $val $sv] }
        }
        return [list value $val]
    }

    # ---- "Commands" scope: commands the program created (procs, aliases, Tk widgets, objects, handles) ----
    proc mustBe {msg} {
        if {![regexp {must be (.*)$} $msg -> tail]} { return {} }
        set tail [string trimright $tail .]
        regsub -all {,? or } $tail {, } tail
        set out {}
        foreach v [split $tail ,] { set v [string trim $v]; if {$v ne ""} { lappend out $v } }
        return $out
    }
    # every command: global ones by plain name, the rest fully qualified ("::platform::generic"); library
    # namespaces (::tcl, ::oo, Tk's, this agent) are skipped
    proc walkCmds {ns} {
        set out {}
        if {$ns eq "::"} {
            foreach c [info commands ::*] { lappend out [string range $c 2 end] }
        } else {
            # inside a namespace, hide helpers by Tcl convention: capitalised names (http::Event ...) unless exported
            set exported [namespace eval $ns {namespace export}]
            foreach c [info commands ${ns}::*] {
                set tail [namespace tail $c]
                if {[string is upper -strict [string index $tail 0]]} {
                    # Capitalised private procs are commonly library internals, but capitalised TclOO
                    # class names are normal public program structure and must remain visible.
                    set keep [expr {![catch {info object isa class $c} isClass] && $isClass}]
                    foreach pat $exported { if {[string match $pat $tail]} { set keep 1; break } }
                    if {!$keep} continue
                }
                lappend out $c
            }
        }
        foreach child [namespace children $ns] {
            if {$child in {::tcl ::oo ::tk ::ttk ::__dbg ::pkg ::auto_mkindex_parser ::tcl::unsupported}} continue
            lappend out {*}[walkCmds $child]
        }
        return $out
    }
    proc newCommands {} {
        variable baseCmds
        set out {}
        foreach c [lsort -dictionary [walkCmds ::]] {
            if {[info exists baseCmds($c)]} continue
            # procs Tcl itself defines lazily (autoloaded library code, package machinery) are not the program's
            if {[info exists ::auto_index($c)] || [string match tclPkg* $c] || [string match tcl_* $c]} continue
            lappend out $c
        }
        return $out
    }
    proc fq {c} { expr {[string match ::* $c] ? $c : "::$c"} }
    proc procArgs {c} {
        set parts {}
        foreach a [info args [fq $c]] {
            if {[info default [fq $c] $a d]} { lappend parts "?$a=$d?" } else { lappend parts $a }
        }
        return $parts
    }
    # -> {kind summary}
    proc cmdKind {c} {
        if {[string match .* $c] && ![catch {winfo class $c} cls]} { return [list widget "$cls widget"] }
        if {[llength [info procs [fq $c]]]} { return [list proc "proc [procArgs $c]"] }
        if {![catch {interp alias {} $c} target] && $target ne ""} { return [list alias "alias -> $target"] }
        if {![catch {info object isa class $c} isc] && $isc} { return [list class "TclOO class"] }
        if {![catch {info object isa object $c} iso] && $iso} {
            catch {info object class $c} cls
            return [list object "object of class $cls"]
        }
        if {![catch {namespace ensemble exists $c} ens] && $ens} { return [list ensemble "ensemble"] }
        return [list command "command (compiled/extension)"]
    }
    # rows {name value} describing one command
    proc cmdRows {c} {
        set rows {}
        lassign [cmdKind $c] kind sum
        switch -- $kind {
            widget {
                if {![catch {$c configure} cfg]} {
                    foreach item $cfg { if {[llength $item] == 5} { lappend rows [list [lindex $item 0] [lindex $item 4]] } }
                }
                if {[catch {$c __nosuchmethod__} msg]} { set m [mustBe $msg]; if {[llength $m]} { lappend rows [list methods [join $m ", "]] } }
            }
            proc { lappend rows [list args [procArgs $c]] }
            alias { lappend rows [list target [interp alias {} $c]] }
            object {
                catch {info object class $c} cls
                lappend rows [list class $cls]
                if {![catch {info object methods $c -all} m]} { lappend rows [list methods [join [lsort $m] ", "]] }
                if {![catch {info object namespace $c} ns]} {
                    foreach v [lsort [catch {info object vars $c} vs; set vs]] {
                        if {![catch {set ${ns}::$v} val]} { lappend rows [list $v $val] }
                    }
                }
            }
            class {
                if {![catch {info class superclasses $c} sc]} { lappend rows [list superclasses $sc] }
                if {![catch {info class methods $c} m]} { lappend rows [list methods [join [lsort $m] ", "]] }
            }
            ensemble {
                if {![catch {namespace ensemble configure $c -subcommands} sub] && [llength $sub]} {
                    lappend rows [list subcommands [join $sub ", "]]
                } elseif {![catch {namespace ensemble configure $c -map} map]} {
                    lappend rows [list subcommands [join [lsort [dict keys $map]] ", "]]
                }
            }
            default {
                # a C command (e.g. an sqlite3 handle): the error for a bogus subcommand lists the real ones
                if {[catch {$c __nosuchsub__} msg]} { set m [mustBe $msg]; if {[llength $m]} { lappend rows [list "subcommands (probed)" [join $m ", "]] } }
            }
        }
        return $rows
    }
    proc doCommands {id} {
        variable inEval
        set inEval 1
        set out {}
        set n 0
        set cmds [newCommands]
        # TclOO objects live in ::oo, not in the global namespace: reach them through their classes
        foreach c $cmds {
            if {![catch {info object isa class $c} isc] && $isc && ![catch {info class instances $c} inst]} {
                foreach o $inst { lappend cmds $o }
            }
        }
        foreach c $cmds {
            if {[incr n] > 500} { lappend out "..." "more" scalar 0 {}; break }
            lassign [cmdKind $c] kind sum
            lappend out [dispName $c] $sum command 1 [list [list cmd $c]]
        }
        set inEval 0
        send vars $id [expr {[llength $out] / 5}] {*}$out
    }
    proc doCommandRows {id c} {
        variable inEval
        set inEval 1
        set out {}
        foreach row [cmdRows $c] {
            lassign $row n v
            lappend out $n [trunc $v] scalar 0 {}
        }
        set inEval 0
        if {![llength $out]} { lappend out "(no details)" "" scalar 0 {} }
        send vars $id [expr {[llength $out] / 5}] {*}$out
    }

    proc doVars {id L scope arg} {
        if {$scope eq "commands"} { doCommands $id; return }
        if {$scope eq "value" && [lindex $arg 0 0] eq "cmd"} { doCommandRows $id [lindex $arg 0 1]; return }
        set out {}
        set limit 500
        if {$scope eq "value"} {
            lassign [resolve $L $arg] what val
            if {$what eq "array"} {
                set i 0
                foreach k [lsort -dictionary [uplevel #$L [list array names $val]]] {
                    if {[incr i] > $limit} { lappend out "..." "[expr {[llength [uplevel #$L [list array names $val]]] - $limit}] more" scalar 0 {}; break }
                    catch {uplevel #$L [list set "${val}($k)"]} ev
                    lassign [describe $ev] t s c
                    lappend out "\[$k\]" $s $t $c [list [list arr $val $k]]
                }
            } else {
                switch -- [kindOf $val] {
                    list {
                        set n [llength $val]
                        for {set i 0} {$i < $n && $i < $limit} {incr i} {
                            lassign [describe [lindex $val $i]] t s c
                            lappend out "\[$i\]" $s $t $c [lappend_path $arg [list idx $i]]
                        }
                        if {$n > $limit} { lappend out "..." "[expr {$n - $limit}] more" scalar 0 {} }
                    }
                    dict {
                        set i 0
                        dict for {k v} $val {
                            if {[incr i] > $limit} { lappend out "..." "[expr {[dict size $val] - $limit}] more" scalar 0 {}; break }
                            lassign [describe $v] t s c
                            lappend out $k $s $t $c [lappend_path $arg [list key $k]]
                        }
                    }
                }
            }
        } else {
            if {$scope eq "global"} {
                set L 0
                set names [uplevel #0 [list info globals]]
            } elseif {$scope eq "namespace"} {
                set L 0
                set names [uplevel #0 [list info vars ${arg}::*]]
            } else {
                set names [uplevel #$L [list info locals]]
            }
            foreach v [lsort -dictionary $names] {
                if {$scope eq "global" && [skipGlobal $v]} continue
                set shown [dispName $v]
                if {$scope eq "namespace"} { set shown [namespace tail $v] }
                set path [list [list var $v]]
                if {[uplevel #$L [list array exists $v]]} {
                    set size [uplevel #$L [list array size $v]]
                    lappend out $shown "array($size)" array [expr {$size > 0}] $path
                } else {
                    if {[catch {uplevel #$L [list set $v]} val]} {
                        lappend out $shown "<unset>" scalar 0 {}
                    } else {
                        lassign [describe $val] t s c
                        lappend out $shown $s $t $c $path
                    }
                }
            }
        }
        send vars $id [expr {[llength $out] / 5}] {*}$out
    }
    # Variable names can hold spaces/newlines (e.g. `db eval SQL {min_age 20} {...}` makes an array literally
    # named "\n    min_age 20\n"): show them quoted on one line instead of as an empty-looking entry.
    proc dispName {v} {
        if {$v ne "" && ![regexp {\s} $v]} { return $v }
        regsub -all {\s+} [list $v] { } d
        return $d
    }
    proc lappend_path {path step} { lappend path $step; return $path }

    # Replace the element at `steps` (idx N / key K ...) inside `cur` by `value`.
    proc setIn {cur steps value} {
        if {![llength $steps]} { return $value }
        lassign [lindex $steps 0] sk sv
        set rest [lrange $steps 1 end]
        if {$sk eq "idx"} {
            lset cur $sv [setIn [lindex $cur $sv] $rest $value]
        } else {
            dict set cur $sv [setIn [dict get $cur $sv] $rest $value]
        }
        return $cur
    }
    # Variables panel edit: path is the element's path as sent by `vars`.
    proc doSetVar {id L path value} {
        variable inEval
        lassign [lindex $path 0] rk name key
        if {$rk eq "var"} { set ref $name } elseif {$rk eq "arr"} { set ref "${name}($key)" } else {
            send setvar $id 1 "this value cannot be edited"
            return
        }
        set inEval 1
        set rc [catch {
            set steps [lrange $path 1 end]
            if {![llength $steps]} {
                uplevel #$L [list set $ref $value]
            } else {
                uplevel #$L [list set $ref [setIn [uplevel #$L [list set $ref]] $steps $value]]
            }
        } err]
        set inEval 0
        if {$rc} { send setvar $id 1 [trunc $err]; return }
        lassign [describe $value] t s c
        send setvar $id 0 $s $t $c $path
    }
    proc doEval {id L expr} {
        variable inEval
        variable held
        set inEval 1
        set isVar [regexp {^\$?([A-Za-z_][A-Za-z0-9_:]*)(\(.*\))?$} $expr -> name idx]
        if {$isVar && $idx eq "" && [uplevel #$L [list array exists $name]]} {
            set inEval 0
            set size [uplevel #$L [list array size $name]]
            send eval $id 0 "array($size)" array [expr {$size > 0}] [list [list var $name]]
            return
        }
        if {$isVar} {
            set rc [catch {uplevel #$L [list set "$name$idx"]} res]
            if {$rc} { set rc [catch {uplevel #$L $expr} res] }
        } else {
            set rc [catch {uplevel #$L $expr} res]
        }
        if {$rc} {
            lassign [evalExpr $L $expr] rc2 res2
            if {!$rc2} { set rc 0; set res $res2 }
        }
        set inEval 0
        if {$rc} {
            send eval $id 1 [trunc $res] scalar 0 {}
            return
        }
        # keep the real value (with its list/dict representation) so the result can be expanded
        set held($id) $res
        lassign [describe $res] t sum c
        send eval $id 0 $sum $t $c [list [list held $id]]
    }

    # ---- stop on errors (even caught ones) ----
    proc setAll {on} {
        variable stopOnAll
        if {$on eq ""} { set on 0 }
        if {$on && !$stopOnAll} {
            trace add execution ::error enter ::__dbg::onError
            trace add execution ::catch leave ::__dbg::onCatch
        } elseif {!$on && $stopOnAll} {
            trace remove execution ::error enter ::__dbg::onError
            trace remove execution ::catch leave ::__dbg::onCatch
        }
        set stopOnAll $on
    }
    # True when the command that raised/caught the error runs inside Tcl/Tk's own library code
    # (auto_load, package loading, Tk init ...): such caught errors are routine noise, not the program's.
    # Must be called directly from the trace handlers.
    proc callerIsLib {} {
        set cl [expr {[info level] - 2}]
        if {$cl <= 0} {
            set sc [info script]
            return [expr {$sc ne "" && [isLib [file normalize $sc]]}]
        }
        set name [lindex [info level $cl] 0]
        if {[regexp {^(::)?(auto_[a-z_]+|unknown|tclPkg[A-Za-z]*|tk_[A-Za-z]+|tcl_[A-Za-z]+|pkg_[A-Za-z]+)$} $name]} { return 1 }
        set ns [uplevel #$cl {namespace current}]
        return [regexp {^::(tcl|tk|ttk|msgcat|platform|safe|oo|tcl::[a-z]+)(::|$)} $ns]
    }
    proc stopCaught {lvl msg info} {
        variable mode
        send caught $msg $info
        set mode run
        send stopped exception $lvl
        commandLoop $lvl
        array unset ::__dbg::held
    }
    proc onError {cmd op} {
        variable inEval
        variable reportedMsg
        if {$inEval} return
        if {[uplevel 1 {namespace current}] eq "::__dbg"} return
        if {[callerIsLib]} return
        set msg [lindex $cmd 1]
        set reportedMsg $msg
        stopCaught [expr {[info level] - 1}] $msg ""
    }
    proc onCatch {cmd code result op} {
        variable inEval
        variable reportedMsg
        if {$inEval || $code != 0 || $result != 1} return
        if {[uplevel 1 {namespace current}] eq "::__dbg"} return
        if {[callerIsLib]} return
        set msg ""
        if {[llength $cmd] >= 3} {
            set inEval 1
            catch {uplevel 1 [list set [lindex $cmd 2]]} msg
            set inEval 0
        }
        if {$reportedMsg ne "" && ($msg eq $reportedMsg || $msg eq "")} {
            set reportedMsg ""
            return
        }
        set info ""
        catch {set info $::errorInfo}
        stopCaught [expr {[info level] - 1}] $msg $info
    }

    # Called (by instrumented code) at the start of a `try ... on error|trap` handler.
    proc tryCaught {msgVar optsVar} {
        variable stopOnAll
        variable inEval
        variable reportedMsg
        if {!$stopOnAll || $inEval} return
        upvar 1 $msgVar m
        set msg [expr {[info exists m] ? $m : ""}]
        if {$reportedMsg ne "" && $msg eq $reportedMsg} { set reportedMsg ""; return }
        set info ""
        if {$optsVar ne "{}" && $optsVar ne ""} {
            upvar 1 $optsVar o
            catch {set info [dict get $o -errorinfo]}
        }
        stopCaught [expr {[info level] - 1}] $msg $info
    }

    proc handleCommon {msg lvl} {
        variable pauseReq
        switch -- [lindex $msg 0] {
            bp      { setBreakpoints $msg }
            exc     { variable stopOnUncaught; set stopOnUncaught [lindex $msg 1]; setAll [lindex $msg 2] }
            pause   { set pauseReq 1 }
            quit    { real_exit 0 }
            stack   { if {$lvl >= 0} { doStack [lindex $msg 1] $lvl } }
            namespace { if {$lvl >= 0} { send namespace [lindex $msg 1] [uplevel #[lindex $msg 2] {namespace current}] } }
            vars    { if {$lvl >= 0} { doVars {*}[lrange $msg 1 4] } }
            eval    { if {$lvl >= 0} { doEval {*}[lrange $msg 1 3] } }
            setvar  { if {$lvl >= 0} { doSetVar {*}[lrange $msg 1 4] } }
        }
    }

    proc poll {} {
        variable sock
        fconfigure $sock -blocking 0
        while {1} {
            set n [gets $sock line]
            if {$n < 0} {
                if {[eof $sock]} { real_exit 1 }
                break
            }
            handleCommon [decode $line] -1
        }
        fconfigure $sock -blocking 1
    }

    proc commandLoop {lvl} {
        variable sock
        variable mode
        variable stepLevel
        while {1} {
            set n [gets $sock line]
            if {$n < 0} {
                if {[eof $sock]} { real_exit 1 }
                continue
            }
            set msg [decode $line]
            switch -- [lindex $msg 0] {
                continue { set mode run; return }
                next     { set mode next; set stepLevel $lvl; return }
                stepin   { set mode in; return }
                stepout  { set mode out; set stepLevel $lvl; return }
                default  { handleCommon $msg $lvl }
            }
        }
    }

    # Called before every instrumented command.
    proc step {line fid} {
        variable files
        variable bp
        variable hits
        variable last
        variable maxLevel
        variable mode
        variable stepLevel
        variable pauseReq
        variable inEval
        variable entryPending
        variable reportedMsg
        variable seenKey
        if {$inEval} return
        set reportedMsg ""
        set lvl [expr {[info level] - 1}]
        set path $files($fid)
        for {set k [expr {$lvl + 1}]} {$k <= $maxLevel} {incr k} { unset -nocomplain last($k) }
        set maxLevel $lvl
        set last($lvl) [list $path $line]
        # Several commands on one line (e.g. `catch {risky} m`: the catch and the command in its body) are one
        # stop for stepping purposes: skip a step that directly follows another on the same line and frame.
        set key "$path:$line:$lvl"
        set same [expr {$key eq $seenKey}]
        set seenKey $key
        poll
        set reason ""
        if {$entryPending} {
            set entryPending 0
            set reason entry
        } elseif {$pauseReq} {
            set pauseReq 0
            set reason pause
        }
        if {$reason eq "" && [info exists bp($path,$line)]} {
            lassign $bp($path,$line) cond logmsg hitspec
            if {[condOk $lvl $cond "[file tail $path]:$line"] && [incr hits($path,$line)] > 0 && [hitOk $hits($path,$line) $hitspec]} {
                if {$logmsg ne ""} {
                    send log [formatLog $lvl $logmsg]
                } else {
                    set reason breakpoint
                }
            }
        }
        if {$reason eq "" && !$same} {
            if {$mode eq "in"} {
                set reason step
            } elseif {$mode eq "next" && $lvl <= $stepLevel} {
                set reason step
            } elseif {$mode eq "out" && $lvl < $stepLevel} {
                set reason step
            }
        }
        if {$reason eq ""} return
        set mode run
        send stopped $reason $lvl
        commandLoop $lvl
        array unset ::__dbg::held
    }

    # ---- GUI programs: like `wish`, keep running the event loop after the script ends ----
    proc onReadable {} {
        variable sock
        fconfigure $sock -blocking 0
        while {1} {
            set n [gets $sock line]
            if {$n < 0} {
                if {[eof $sock]} { real_exit 1 }
                break
            }
            handleCommon [decode $line] -1
        }
        fconfigure $sock -blocking 1
    }
    proc eventLoop {} {
        variable sock
        variable inLoop
        set inLoop 1
        fileevent $sock readable ::__dbg::onReadable
        catch {tkwait window .}
        fileevent $sock readable {}
        set inLoop 0
    }

    # ---- source / exit overrides ----
    proc isLib {path} {
        foreach d [concat [info library] $::auto_path] {
            set nd [file normalize $d]
            if {[string first "$nd/" $path] == 0} { return 1 }
        }
        return 0
    }
    proc fetchSource {path {enc ""}} {
        variable sock
        variable files
        send needsource $path $enc
        while {1} {
            set n [gets $sock line]
            if {$n < 0} {
                if {[eof $sock]} { real_exit 1 }
                continue
            }
            set msg [decode $line]
            if {[lindex $msg 0] eq "source"} {
                lassign [lrange $msg 1 4] fid canon code native
                set files($fid) $canon
                return [list $canon $code $native]
            }
            handleCommon $msg -1
        }
    }
    proc mysource {args} {
        set enc ""
        if {[llength $args] == 3 && [lindex $args 0] eq "-encoding"} {
            set path [lindex $args 2]
            set enc [lindex $args 1]
        } elseif {[llength $args] == 1} {
            set path [lindex $args 0]
        } else {
            return [uplevel 1 [list ::__dbg::real_source {*}$args]]
        }
        set norm [file normalize $path]
        if {![file isfile $norm] || [isLib $norm]} {
            return [uplevel 1 [list ::__dbg::real_source {*}$args]]
        }
        lassign [fetchSource $norm $enc] canon code native
        if {$native ne ""} {
            return [uplevel 1 [list ::__dbg::real_source {*}$args]]
        }
        set old [info script]
        info script $norm
        set rc [catch {uplevel 1 $code} res opts]
        info script $old
        if {$rc == 0 || $rc == 2} { return $res }
        return -options $opts $res
    }

    proc main {argv} {
        variable baseCmds
        variable sock
        variable entryPending
        variable stopOnUncaught
        variable uncaughtLoc
        variable last
        variable maxLevel
        set port [lindex $argv 0]
        set program [lindex $argv 1]
        set rest [lrange $argv 2 end]
        set sock [socket 127.0.0.1 $port]
        fconfigure $sock -translation lf -encoding utf-8 -buffering line -blocking 1
        fconfigure stdout -buffering line
        rename ::exit ::__dbg::real_exit
        proc ::exit {{code 0}} { ::__dbg::send exited $code; ::__dbg::real_exit $code }
        rename ::source ::__dbg::real_source
        interp alias {} ::source {} ::__dbg::mysource
        send hello
        # wait for breakpoints and the go signal
        while {1} {
            set n [gets $sock line]
            if {$n < 0} {
                if {[eof $sock]} { real_exit 1 }
                continue
            }
            set msg [decode $line]
            if {[lindex $msg 0] eq "go"} {
                set entryPending [lindex $msg 1]
                break
            }
            handleCommon $msg -1
        }
        foreach c [walkCmds ::] { set baseCmds($c) 1 }   ;# Commands scope lists what the program adds
        set ::argv0 $program
        set ::argv $rest
        set ::argc [llength $rest]
        set rc [catch {uplevel #0 [list ::source $program]} msg opts]
        if {$rc == 1} {
            send uncaught $msg [dict get $opts -errorinfo]
            variable stopOnAll
            variable reportedMsg
            if {$stopOnUncaught && !($stopOnAll && $reportedMsg eq $msg) && [info exists last($maxLevel)]} {
                set uncaughtLoc $last($maxLevel)
                send stopped exception 0
                commandLoop 0
            }
            real_exit 1
        }
        if {[llength [info commands ::winfo]] && ![catch {winfo exists .} ex] && $ex} { eventLoop }
        send exited 0
        real_exit 0
    }
}
::__dbg::main $argv
