# 运行测试

把 `tcltest` 用例放进 `*.test` 文件，它们会出现在 VS Code 的 **测试** 视图中，可以运行单个用例、单个文件或全部。

```tcl
package require tcltest
namespace import ::tcltest::*

test add-1 {adds numbers} -body {
    expr {1 + 2}
} -result 3

cleanupTests
```

选择 **Debug** 配置，即可在用例内部的断点处停下。
