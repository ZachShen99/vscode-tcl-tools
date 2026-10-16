# 17 - SQLite 句柄补全(需要 Tcl 的 sqlite3 包)
#
# 手动测试:
#   1. 在下面空行输入 "db " (db 后面带空格):应列出 eval / transaction / onecolumn ... 全部子命令
#   2. 输入 "db tr" 过滤出 transaction / trace / trace_v2
#   3. 输入 "db transaction " 应提示 deferred / exclusive / immediate
#   4. 输入 "db eval {" 时右下角出现签名提示,当前参数随输入前进
#   5. 鼠标悬停在 db 上看句柄说明,悬停在 eval 上看用法
#   6. 把 db 换成任意其他名字(如 sqlite3 conn :memory:),conn 也同样可补全
package require sqlite3

sqlite3 db :memory:
db eval {CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)}

db transaction {
    db eval {INSERT INTO t(name) VALUES('a'), ('b')}
}

puts "rows: [db onecolumn {SELECT count(*) FROM t}]"
puts "last id: [db last_insert_rowid]"

db close
