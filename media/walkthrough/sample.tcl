# Tcl Tools sample file
# Try completion, hover, diagnostics, Run and Debug on this file.

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

# 1. Type "geometry::" on a new line below and look at the completion list.
# 2. Hover over a command name such as puts or geometry::area.
# 3. The next line misspells a command. With introspection on, it gets a warning.
putss "oops"

# 4. Click left of a line number above to set a breakpoint, then press F5.
