// ─── databases.rs — 登记的数据库连接（服务器侧存储） ───────────────────
// 存 ~/.agent-ui/databases.json（JSON 数组，含密码，权限 600）。
// 组件（如 update-table）按登记名引用；密码不进节点配置、不进公共仓库。

use serde::{Deserialize, Serialize};

use crate::utils::{databases_path, error_to_string};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRegistration {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    #[serde(default)]
    pub password: String,
}

/// GET /databases 的返回形态：不含密码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
}

impl From<&DatabaseRegistration> for DatabaseInfo {
    fn from(reg: &DatabaseRegistration) -> Self {
        DatabaseInfo {
            name: reg.name.clone(),
            host: reg.host.clone(),
            port: reg.port,
            dbname: reg.dbname.clone(),
            user: reg.user.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseTestResult {
    pub ok: bool,
    pub message: String,
}

pub fn validate(reg: &DatabaseRegistration) -> Result<(), String> {
    let name_ok = !reg.name.is_empty()
        && reg
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !name_ok {
        return Err("数据库名称只能包含字母、数字、下划线、连字符".to_string());
    }
    if reg.host.trim().is_empty() {
        return Err("主机地址不能为空".to_string());
    }
    if reg.user.trim().is_empty() {
        return Err("用户名不能为空".to_string());
    }
    Ok(())
}

pub fn load_databases() -> Result<Vec<DatabaseRegistration>, String> {
    load_databases_from(&databases_path()?)
}

pub fn load_databases_from(path: &std::path::Path) -> Result<Vec<DatabaseRegistration>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read databases: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse databases: {e}"))
}

pub fn save_databases_to(path: &std::path::Path, list: &[DatabaseRegistration]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create databases dir: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(list)
        .map_err(|e| format!("failed to serialize databases: {e}"))?;
    std::fs::write(path, &raw).map_err(error_to_string)?;
    // 含密码的文件，收紧为仅属主可读写（Unix；Windows 不支持 chmod，跳过）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 新增或整条替换（name 是主键）。password 留空 = 沿用原密码。
pub fn upsert_database(reg: DatabaseRegistration) -> Result<DatabaseInfo, String> {
    upsert_database_to(&databases_path()?, reg)
}

pub fn upsert_database_to(
    path: &std::path::Path,
    reg: DatabaseRegistration,
) -> Result<DatabaseInfo, String> {
    validate(&reg)?;
    let mut list = load_databases_from(path)?;
    let mut saved = reg;
    if let Some(existing) = list.iter_mut().find(|r| r.name == saved.name) {
        if saved.password.is_empty() {
            saved.password = existing.password.clone();
        }
        *existing = saved.clone();
    } else {
        list.push(saved.clone());
    }
    save_databases_to(path, &list)?;
    Ok(DatabaseInfo::from(&saved))
}

pub fn find_database(name: &str) -> Result<DatabaseRegistration, String> {
    load_databases()?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| format!("数据库 {name} 未登记"))
}

pub fn remove_database(name: &str) -> Result<(), String> {
    remove_database_from(&databases_path()?, name)
}

pub fn remove_database_from(path: &std::path::Path, name: &str) -> Result<(), String> {
    let mut list = load_databases_from(path)?;
    let before = list.len();
    list.retain(|r| r.name != name);
    if list.len() == before {
        return Err(format!("数据库 {name} 未登记"));
    }
    save_databases_to(path, &list)
}

/// 真实连一次库（TCP + 认证 + SELECT 1），8 秒超时。失败不是服务器错误，
/// 以 ok=false 的测试结果返回。
pub async fn test_connection(reg: &DatabaseRegistration) -> DatabaseTestResult {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&reg.host)
        .port(reg.port)
        .user(&reg.user)
        .password(&reg.password);
    // dbname 留空 = 连用户默认库（与 user 同名）。
    if !reg.dbname.trim().is_empty() {
        config.dbname(&reg.dbname);
    }
    let probe = async {
        let (client, connection) = config.connect(tokio_postgres::NoTls).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        client.query_one("SELECT 1", &[]).await?;
        Ok::<(), tokio_postgres::Error>(())
    };
    match tokio::time::timeout(std::time::Duration::from_secs(8), probe).await {
        Ok(Ok(())) => DatabaseTestResult {
            ok: true,
            message: "连接成功".to_string(),
        },
        Ok(Err(e)) => DatabaseTestResult {
            ok: false,
            message: error_chain_message(&e),
        },
        Err(_) => DatabaseTestResult {
            ok: false,
            message: "连接超时（8 秒）".to_string(),
        },
    }
}

/// tokio-postgres 的顶层错误只有 "error connecting to server"，展开
/// source 链（如 "Connection refused"）才能看出失败原因。
fn error_chain_message(err: &tokio_postgres::Error) -> String {
    let mut msg = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str, password: &str) -> DatabaseRegistration {
        DatabaseRegistration {
            name: name.to_string(),
            host: "192.168.1.50".to_string(),
            port: 5432,
            dbname: "dw".to_string(),
            user: "etl".to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn test_load_nonexistent_file_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nonexistent.json");
        assert!(load_databases_from(&path).unwrap().is_empty());
    }

    #[test]
    fn test_upsert_and_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("databases.json");

        let saved = upsert_database_to(&path, sample("dw-main", "secret")).unwrap();
        assert_eq!(saved.name, "dw-main");

        let loaded = load_databases_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].password, "secret");
    }

    #[test]
    fn test_upsert_empty_password_keeps_old() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("databases.json");

        upsert_database_to(&path, sample("dw-main", "secret")).unwrap();
        upsert_database_to(&path, sample("dw-main", "")).unwrap();

        let loaded = load_databases_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].password, "secret");
    }

    #[test]
    fn test_upsert_invalid_name_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("databases.json");

        let mut bad = sample("dw main", "x");
        assert!(upsert_database_to(&path, bad.clone()).is_err());
        bad.name = "dw/main".to_string();
        assert!(upsert_database_to(&path, bad).is_err());
    }

    #[test]
    fn test_remove_missing_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("databases.json");
        upsert_database_to(&path, sample("dw-main", "secret")).unwrap();

        let err = remove_database_from(&path, "nope").unwrap_err();
        assert!(err.contains("未登记"));
        remove_database_from(&path, "dw-main").unwrap();
        assert!(load_databases_from(&path).unwrap().is_empty());
    }

    #[test]
    fn test_upsert_empty_dbname_allowed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("databases.json");

        let mut reg = sample("dw-main", "secret");
        reg.dbname = "  ".to_string();
        upsert_database_to(&path, reg).unwrap();

        let loaded = load_databases_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn test_load_corrupted_file_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.json");
        std::fs::write(&path, "not valid json {{{").unwrap();
        assert!(load_databases_from(&path).is_err());
    }
}
