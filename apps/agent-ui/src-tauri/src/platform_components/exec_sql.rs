//! Exec-SQL 组件的域逻辑（validate）。
//!
//! 放这里而不是组件仓库：validate 需要 platform 的连接登记（密码只在
//! `~/.agent-ui/databases.json`），且必须在提交前就能跑，不能等 worker。
//!
//! validate 语义：连接登记存在 + 能连上 + 每条 SQL 都能被数据库 EXPLAIN。
//! EXPLAIN 只做计划不执行，INSERT/UPDATE 也会被完整校验（表/列/权限）。

use super::{ValidateFuture, ValidateResult};
use crate::databases;

pub fn validate(params: serde_json::Value) -> ValidateFuture {
    Box::pin(async move {
        let get = |key: &str| {
            params
                .get(key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let Some(connection) = get("connection") else {
            return fail("缺少必填参数 connection（数据库连接名）。");
        };
        let Some(database) = get("database") else {
            return fail("缺少必填参数 database（数据库名）。");
        };
        let Some(sql) = get("sql") else {
            return fail("缺少必填参数 sql。");
        };

        let Ok(reg) = databases::find_database(&connection) else {
            return fail(format!("连接名「{connection}」未在高级配置的数据库登记中找到。"));
        };

        let statements = split_statements(&sql);
        if statements.is_empty() {
            return fail("sql 里没有可执行的语句。");
        }

        let probe = async {
            let (client, _conn_task) = databases::connect(&reg, Some(&database))
                .await
                .map_err(|e| format!("连接数据库失败: {}", databases::error_chain_message(&e)))?;
            for (i, stmt) in statements.iter().enumerate() {
                let explain = neutralize_query_tokens(stmt);
                client
                    .query_one(&format!("EXPLAIN {explain}"), &[])
                    .await
                    .map_err(|e| format!("第 {} 条语句: {}", i + 1, databases::error_chain_message(&e)))?;
            }
            Ok::<(), String>(())
        };
        match tokio::time::timeout(std::time::Duration::from_secs(15), probe).await {
            Ok(Ok(())) => ValidateResult {
                ok: true,
                message: format!("校验通过：{} 条语句均可执行（EXPLAIN）。", statements.len()),
            },
            Ok(Err(msg)) => fail(msg),
            Err(_) => fail("校验超时（15 秒）：数据库无响应。"),
        }
    })
}

fn fail(message: impl Into<String>) -> ValidateResult {
    ValidateResult {
        ok: false,
        message: message.into(),
    }
}

/// 把 `$端口.列` 模板 token 中和成字面量 `NULL`，以便 EXPLAIN。
/// 运行时的 `$x.col` 会被组件替换成绑定参数 %(pN)s，两者都不能直接进
/// EXPLAIN（PG 不认）；validate 只验证「换了占位符后语法 + 表/列/权限」。
/// 中和成 `NULL` 而非 `1`：NULL 对任何列类型都成立——若中和成 `1`，对
/// date/boolean 等非数值列，EXPLAIN 会因类型不匹配而误报。冲突仲裁键
/// 所在的列保持原样，EXPLAIN 仍能校验其存在。PG 自身参数 `$1`（数字）
/// 不受影响，原样保留。
fn neutralize_query_tokens(sql: &str) -> String {
    let b: Vec<char> = sql.chars().collect();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    while i < n {
        if b[i] == '$' {
            let mut j = i + 1;
            // ident1：首字符须字母或下划线（与 PG 参数 `$1` 区分）
            if j < n && (b[j].is_ascii_alphabetic() || b[j] == '_') {
                let mut k = j;
                while k < n && (b[k].is_ascii_alphanumeric() || b[k] == '_') {
                    k += 1;
                }
                if k < n && b[k] == '.' {
                    let l0 = k + 1;
                    let mut l = l0;
                    while l < n && (b[l].is_ascii_alphanumeric() || b[l] == '_') {
                        l += 1;
                    }
                    if l > l0 {
                        out.push_str("NULL");
                        i = l;
                        continue;
                    }
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// 剥掉 `-- 行注释` 与 `/* 块注释 */` 后按分号拆分。
/// EXPLAIN 一次只能吃一条语句；不剥注释时注释里的分号会误拆。
/// 字符串字面量（'...'，'' 转义）原样保留，其中的分号不参与拆分。
pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            // 字符串字面量：原样拷贝到闭合引号（'' 是转义的引号，继续）。
            current.push(c);
            i += 1;
            while i < chars.len() {
                current.push(chars[i]);
                if chars[i] == '\'' {
                    i += 1;
                    if i < chars.len() && chars[i] == '\'' {
                        current.push(chars[i]);
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
        } else if c == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
        } else if c == ';' {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                out.push(trimmed);
            }
            current.clear();
            i += 1;
        } else {
            current.push(c);
            i += 1;
        }
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        out.push(trimmed);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_multiple_statements() {
        let out = split_statements("INSERT INTO a VALUES(1);\nUPDATE b SET x=2; SELECT 1;");
        assert_eq!(out, vec!["INSERT INTO a VALUES(1)", "UPDATE b SET x=2", "SELECT 1"]);
    }

    #[test]
    fn ignores_semicolons_in_comments() {
        let out = split_statements("-- 注释; 分号\nSELECT 1; /* 块;注释 */ SELECT 2;");
        assert_eq!(out, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn empty_and_comment_only_yields_nothing() {
        assert!(split_statements("").is_empty());
        assert!(split_statements("-- only a comment;").is_empty());
        assert!(split_statements(";;;").is_empty());
    }

    #[test]
    fn string_literals_are_kept_verbatim() {
        let out = split_statements("SELECT 'a;b' FROM t;");
        assert_eq!(out, vec!["SELECT 'a;b' FROM t"]);
    }

    #[test]
    fn neutralizes_query_tokens_to_literal() {
        let sql = concat!(
            "INSERT INTO t(id, price) VALUES ($Input.id, $Input.price) ",
            "ON CONFLICT(id) DO UPDATE SET price = EXCLUDED.price"
        );
        assert_eq!(
            neutralize_query_tokens(sql),
            concat!(
                "INSERT INTO t(id, price) VALUES (NULL, NULL) ",
                "ON CONFLICT(id) DO UPDATE SET price = EXCLUDED.price"
            )
        );
    }

    #[test]
    fn pg_positional_params_are_untouched() {
        assert_eq!(neutralize_query_tokens("SELECT * FROM t WHERE id = $1"), "SELECT * FROM t WHERE id = $1");
        assert_eq!(neutralize_query_tokens("SELECT $Input.x"), "SELECT NULL");
    }
}
