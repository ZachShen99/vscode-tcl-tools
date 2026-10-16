namespace eval mathlib {
    # 两个整数的最大公约数。
    proc gcd {a b} {
        while {$b != 0} { lassign [list $b [expr {$a % $b}]] a b }
        return $a
    }
    # 最小公倍数。
    proc lcm {a b} { expr {$a / [gcd $a $b] * $b} }
}
# 命名空间之外的全局辅助函数。
proc clamp {x lo hi} { expr {$x < $lo ? $lo : ($x > $hi ? $hi : $x)} }
