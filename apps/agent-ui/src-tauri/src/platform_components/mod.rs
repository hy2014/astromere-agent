//! 平台组件域逻辑（Rust 侧）。
//!
//! 一个平台组件一个文件（如 `exec_sql.rs`），在 `registry()` 里注册自己的
//! validate 处理器。新组件 = 新文件 + 一行注册，其余代码不动。
//! 未注册 validate 的组件：前端不显示「验证配置」按钮，行为不变。

pub mod exec_sql;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

/// validate 结果：ok=false 时 message 说明原因（前端原样展示）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ValidateResult {
    pub ok: bool,
    pub message: String,
}

pub type ValidateFuture = Pin<Box<dyn Future<Output = ValidateResult> + Send>>;
pub type ValidateHandler = fn(serde_json::Value) -> ValidateFuture;

/// 组件 name → validate 处理器。启动后不变。
pub fn registry() -> &'static HashMap<&'static str, ValidateHandler> {
    static REGISTRY: OnceLock<HashMap<&'static str, ValidateHandler>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut m: HashMap<&'static str, ValidateHandler> = HashMap::new();
        m.insert("Exec-SQL", exec_sql::validate);
        m
    })
}

/// 该组件是否提供 validate（按组件 name 查）。
pub fn has_validate(component_name: &str) -> bool {
    registry().contains_key(component_name)
}
