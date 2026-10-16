# Run tests

Put `tcltest` cases in `*.test` files. They appear in VS Code's **Testing** view, where you can run one test, one file or everything.

```tcl
package require tcltest
namespace import ::tcltest::*

test add-1 {adds numbers} -body {
    expr {1 + 2}
} -result 3

cleanupTests
```

Choose the **Debug** profile to stop at breakpoints inside a test.
