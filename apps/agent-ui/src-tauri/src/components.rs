//! Component CRUD and verification for the DAG platform.
//! A component is bound to a user project directory; its actual root is the
//! directory containing the entry_point file (e.g. /a/b/c/xxxx/main.py => root /a/b/c/xxxx).

use crate::sqlite::open_sqlite_database;
use crate::types::Component;
use rusqlite::params;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Resolve the component root directory from an entry point path.
/// /a/b/c/xxxx/main.py -> /a/b/c/xxxx
pub fn component_root_from_entry_point(entry_point: &str) -> Result<PathBuf, String> {
    let path = Path::new(entry_point);
    let parent = path
        .parent()
        .ok_or_else(|| format!("entry_point has no parent directory: {entry_point}"))?;
    if parent.as_os_str().is_empty() {
        return Err(format!(
            "entry_point has no parent directory: {entry_point}"
        ));
    }
    Ok(parent.to_path_buf())
}

fn row_to_component(row: &rusqlite::Row) -> Result<Component, rusqlite::Error> {
    let input_schema_json: String = row.get("input_schema")?;
    let input_schema: Value =
        serde_json::from_str(&input_schema_json).unwrap_or(Value::Object(Map::new()));

    let output_schema_json: String = row.get("output_schema")?;
    let output_schema: Value =
        serde_json::from_str(&output_schema_json).unwrap_or(Value::Object(Map::new()));

    // `config_schema` was added AFTER some component rows already existed, so
    // legacy rows carry a NULL there. Reading it as a non-optional `String`
    // made rusqlite return InvalidColumnType on NULL and aborted the WHOLE
    // `list_components` / `get_component` call — which left the frontend
    // `components` list empty and made every canvas node render as the
    // "Unknown" fallback (and selection reported "this node has no associated
    // component") after a reload. Read it as `Option<String>` and fall back to
    // an empty array.
    let config_schema_json: String =
        row.get::<_, Option<String>>("config_schema")?.unwrap_or_else(|| "[]".to_string());
    let config_schema: Value =
        serde_json::from_str(&config_schema_json).unwrap_or(Value::Array(Vec::new()));

    let tags_json: String = row.get("tags")?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

    // `global` may be NULL on legacy rows created before the column existed;
    // treat NULL as 0 (generic, non-global).
    let global: i64 = row.get::<_, Option<i64>>("global")?.unwrap_or(0);

    Ok(Component {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        status: row.get("status")?,
        workspace_root: row.get("workspace_root")?,
        git_url: row.get("git_url")?,
        git_branch: row.get("git_branch")?,
        git_ref: row.get("git_ref")?,
        entry_point: row.get("entry_point")?,
        input_schema,
        output_schema,
        config_schema,
        tags,
        global: global != 0,
        created_at_ms: row.get("created_at_ms")?,
        updated_at_ms: row.get("updated_at_ms")?,
    })
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn list_components() -> Result<Vec<Component>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
        "SELECT id, name, description, status, workspace_root, git_url, git_branch, \
         git_ref, entry_point, input_schema, output_schema, config_schema, tags, global, \
         created_at_ms, updated_at_ms FROM components \
         ORDER BY updated_at_ms DESC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map([], row_to_component)
        .map_err(error_to_string)?;

    let mut components = Vec::new();
    for row in rows {
        components.push(row.map_err(error_to_string)?);
    }
    Ok(components)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn get_component(component_id: String) -> Result<Component, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
        "SELECT id, name, description, status, workspace_root, git_url, git_branch, \
         git_ref, entry_point, input_schema, output_schema, config_schema, tags, global, \
         created_at_ms, updated_at_ms FROM components WHERE id = ?1",
        )
        .map_err(error_to_string)?;

    let component = statement
        .query_row(params![component_id], row_to_component)
        .map_err(error_to_string)?;

    Ok(component)
}

pub fn insert_component(component: &Component) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    let input_schema_json = serde_json::to_string(&component.input_schema).map_err(error_to_string)?;
    let output_schema_json =
        serde_json::to_string(&component.output_schema).map_err(error_to_string)?;
    let tags_json = serde_json::to_string(&component.tags).map_err(error_to_string)?;
    let config_schema_json =
        serde_json::to_string(&component.config_schema).map_err(error_to_string)?;

    conn.execute(
        "INSERT INTO components (id, name, description, status, workspace_root, git_url, \
         git_branch, git_ref, entry_point, input_schema, output_schema, config_schema, tags, global, \
         created_at_ms, updated_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            component.id,
            component.name,
            component.description,
            component.status,
            component.workspace_root,
            component.git_url,
            component.git_branch,
            component.git_ref,
            component.entry_point,
            input_schema_json,
            output_schema_json,
            config_schema_json,
            tags_json,
            component.global as i64,
            component.created_at_ms,
            component.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;

    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn update_component(component: Component) -> Result<Component, String> {
    let (conn, _path) = open_sqlite_database()?;
    // Same name-uniqueness guard as create_component, but exclude the row
    // being edited (match by id) so renaming to its own current name is a
    // no-op, and renaming onto another component's name (any global flag) is
    // blocked. Uniqueness is global across the whole `components` table.
    let name = component.name.trim();
    if name.is_empty() {
        return Err("组件名称不能为空。".to_string());
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM components WHERE name = ?1 AND id != ?2",
            params![name, component.id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if dup > 0 {
        return Err(format!(
            "已存在同名组件「{}」，请换一个名称，或修改该已有组件。",
            name
        ));
    }
    let input_schema_json = serde_json::to_string(&component.input_schema).map_err(error_to_string)?;
    let output_schema_json =
        serde_json::to_string(&component.output_schema).map_err(error_to_string)?;
    let tags_json = serde_json::to_string(&component.tags).map_err(error_to_string)?;
    let config_schema_json =
        serde_json::to_string(&component.config_schema).map_err(error_to_string)?;

    conn.execute(
        "UPDATE components SET name = ?2, description = ?3, status = ?4, workspace_root = ?5, \
         git_url = ?6, git_branch = ?7, git_ref = ?8, entry_point = ?9, \
         input_schema = ?10, output_schema = ?11, config_schema = ?12, tags = ?13, global = ?14, updated_at_ms = ?15 \
         WHERE id = ?1",
        params![
            component.id,
            component.name,
            component.description,
            component.status,
            component.workspace_root,
            component.git_url,
            component.git_branch,
            component.git_ref,
            component.entry_point,
            input_schema_json,
            output_schema_json,
            config_schema_json,
            tags_json,
            component.global as i64,
            component.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;

    Ok(component)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn create_component(component: Component) -> Result<Component, String> {
    // Guard: component *names* must be unique across the whole `components`
    // table (global=true registered AND global=false generic). Generic
    // components dragged onto the canvas now get a random default name
    // (`generic-component-<suffix>`), so each is already distinct and a second
    // generic drop no longer collides — global uniqueness is safe. Mirror the
    // "block if referenced" style: a friendly business-layer error, not a DB
    // constraint (which would require a schema migration and break on the
    // pre-existing duplicate "generic component" rows).
    let name = component.name.trim();
    if name.is_empty() {
        return Err("组件名称不能为空。".to_string());
    }
    let (conn, _path) = open_sqlite_database()?;
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM components WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if dup > 0 {
        return Err(format!(
            "已存在同名组件「{}」，请换一个名称，或修改该已有组件。",
            name
        ));
    }
    drop(conn);
    insert_component(&component)?;
    Ok(component)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn delete_component(component_id: String) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    // Guard: refuse to delete a component still referenced by any DAG node.
    // `dag_nodes.component_id` has `ON DELETE CASCADE`, so a bare DELETE would
    // silently wipe every referencing node and leave dangling `dag_edges`
    // (edges are plain TEXT with no FK to nodes). Block instead and let the
    // user remove those nodes first — mirrors the "published DAG must be taken
    // offline before delete" guard on `delete_dag`.
    let referenced: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM dag_nodes WHERE component_id = ?1",
            params![component_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if referenced > 0 {
        return Err(format!(
            "该组件正被 {} 个 DAG 节点引用，无法删除：请先在画布中删除这些组件节点（或在节点上右键「删除」）后再试。",
            referenced
        ));
    }
    conn.execute("DELETE FROM components WHERE id = ?1", params![component_id])
        .map_err(error_to_string)?;
    Ok(())
}

/// Verify a component is ready for publishing.
/// Required files in the component root (entry_point parent directory):
/// - entry_point file itself
/// - requirements.txt
/// - SKILL.md
///
/// (`component.json` was removed as a required file on 2026-07-11: its contents
/// were never read at runtime and it drifted from the database contract.)
#[cfg_attr(feature = "gui", tauri::command)]
pub fn verify_component(component_id: String) -> Result<Vec<String>, String> {
    let component = get_component(component_id)?;
    let root = component_root_from_entry_point(&component.entry_point)?;
    let mut missing = Vec::new();

    let entry_file = Path::new(&component.entry_point)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| component.entry_point.clone());

    let required = [
        (entry_file, Path::new(&component.entry_point).to_path_buf()),
        ("requirements.txt".to_string(), root.join("requirements.txt")),
        ("SKILL.md".to_string(), root.join("SKILL.md")),
    ];

    for (name, path) in required {
        if !path.exists() {
            missing.push(name);
        }
    }

    Ok(missing)
}

pub fn read_component_file(entry_point: &str, file_name: &str) -> Result<String, String> {
    let root = component_root_from_entry_point(entry_point)?;
    let path = root.join(file_name);
    fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {}", path.display(), e))
}

pub fn write_component_file(entry_point: &str, file_name: &str, content: &str) -> Result<(), String> {
    let root = component_root_from_entry_point(entry_point)?;
    fs::write(root.join(file_name), content).map_err(error_to_string)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn list_component_files(component_id: String) -> Result<Vec<String>, String> {
    let component = get_component(component_id)?;
    let root = component_root_from_entry_point(&component.entry_point)?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in fs::read_dir(&root).map_err(error_to_string)? {
        let entry = entry.map_err(error_to_string)?;
        if entry.path().is_file() {
            files.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::build_snapshot;
    use crate::types::{DagDetail, DagNode, DagNodePosition};
    use std::sync::Mutex;

    // DB-backed tests set the process-global AGENT_UI_DB_PATH env var, which
    // would race under parallel test threads. Serialize them with this lock.
    static DB_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_db() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("claw-test-{}-{}", std::process::id(), uuid_suffix()));
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("agent-ui-test.db");
        let _ = std::fs::remove_file(&db_path);
        std::env::set_var("AGENT_UI_DB_PATH", &db_path);
        db_path
    }

    fn uuid_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }

    fn sample_component(id: &str) -> Component {
        Component {
            id: id.to_string(),
            name: "demo".to_string(),
            description: "d".to_string(),
            status: "draft".to_string(),
            workspace_root: "".to_string(),
            git_url: "git@github.com:org/repo.git".to_string(),
            git_branch: "main".to_string(),
            git_ref: "v1.0".to_string(),
            entry_point: "run.py".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {}}),
            output_schema: serde_json::json!({"type": "object", "properties": {}}),
            config_schema: serde_json::json!([
                {"key": "year", "label": "年份", "type": "number", "required": true},
                {"key": "mode", "label": "模式", "type": "enum", "required": false, "enum": ["full", "incremental"]}
            ]),
            tags: vec!["t".to_string()],
            global: true,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn test_component_root_from_entry_point() {
        let root = component_root_from_entry_point("/a/b/c/xxxx/main.py").unwrap();
        assert_eq!(root, PathBuf::from("/a/b/c/xxxx"));
    }

    #[test]
    fn test_component_root_relative_entry_point() {
        let root = component_root_from_entry_point("xxxx/main.py").unwrap();
        assert_eq!(root, PathBuf::from("xxxx"));
    }

    #[test]
    fn test_component_root_entry_point_without_parent_errors() {
        let result = component_root_from_entry_point("main.py");
        assert!(result.is_err());
    }

    // The git columns are the configuration truth-source: a round-trip through
    // the DB must preserve them.
    #[test]
    fn test_component_git_columns_roundtrip() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        insert_component(&sample_component("c-git-1")).expect("insert");
        let fetched = get_component("c-git-1".to_string()).expect("get");
        assert_eq!(fetched.git_url, "git@github.com:org/repo.git");
        assert_eq!(fetched.git_branch, "main");
        assert_eq!(fetched.git_ref, "v1.0");
        assert_eq!(fetched.entry_point, "run.py");
        assert_eq!(fetched.workspace_root, "");
        assert!(fetched.global, "sample_component is global=true");

        let _ = std::fs::remove_file(&db_path);
    }

    // The `global` flag distinguishes a registered (global=true, reusable across
    // DAGs) component from a generic non-global one (global=false). It must
    // round-trip through the DB.
    #[test]
    fn test_component_global_column_roundtrip() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        // generic, non-global component (dragged onto the canvas)
        let mut generic = sample_component("c-global-generic");
        generic.global = false;
        insert_component(&generic).expect("insert generic");
        // registered, global component (reusable across DAGs)
        let mut registered = sample_component("c-global-registered");
        registered.global = true;
        insert_component(&registered).expect("insert registered");

        let g = get_component("c-global-generic".to_string()).expect("get generic");
        let r = get_component("c-global-registered".to_string()).expect("get registered");
        assert!(!g.global, "generic component must be global=false");
        assert!(r.global, "registered component must be global=true");

        let _ = std::fs::remove_file(&db_path);
    }

    // The `config_schema` column carries the component's parameter declarations;
    // a round-trip through the DB must preserve them.
    #[test]
    fn test_component_config_schema_roundtrip() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        insert_component(&sample_component("c-schema-1")).expect("insert");
        let fetched = get_component("c-schema-1".to_string()).expect("get");
        let schema = fetched.config_schema.as_array().expect("config_schema is an array");
        assert_eq!(schema.len(), 2, "expected two declared params");
        assert_eq!(schema[0]["key"], "year");
        assert_eq!(schema[0]["type"], "number");
        assert_eq!(schema[1]["key"], "mode");
        assert_eq!(schema[1]["type"], "enum");

        // Legacy rows (no schema) must be read back as an empty array, never NULL.
        let _ = std::fs::remove_file(&db_path);
    }

    // Regression: a legacy `components` row whose JSON columns (config_schema,
    // input_schema, output_schema, tags) are NULL must NOT make list_components
    // / get_component abort. Reading them as a non-optional `String` made
    // rusqlite return InvalidColumnType on NULL, which threw and left the
    // frontend `components` list empty — so every canvas node rendered as the
    // "Unknown" fallback and selection reported "this node has no associated
    // component" after a reload. See the Option<String> fix in `row_to_component`.
    #[test]
    fn test_list_components_tolerates_null_json_columns() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        let (conn, _path) = crate::sqlite::open_sqlite_database().expect("open db");
        conn.execute(
            "INSERT INTO components \
             (id, name, description, status, workspace_root, git_url, git_branch, git_ref, \
              entry_point, input_schema, output_schema, config_schema, tags, global, \
              created_at_ms, updated_at_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                "c-legacy-null",
                "legacy",
                "",
                "draft",
                "",
                "",
                "",
                "",
                "main.py",
                "{\"type\":\"object\",\"properties\":{}}", // input_schema: NOT NULL
                "{\"type\":\"object\",\"properties\":{}}", // output_schema: NOT NULL
                Option::<String>::None,                   // config_schema: nullable (legacy)
                "[]",                                     // tags: NOT NULL
                0i64,
                0i64,
                0i64
            ],
        )
        .expect("insert legacy row with NULL config_schema");

        // Previously this threw InvalidColumnType on the NULL config_schema and
        // aborted the entire listing.
        let all = list_components().expect("list_components must tolerate NULL json columns");
        let found = all
            .iter()
            .find(|c| c.id == "c-legacy-null")
            .expect("legacy row present in listing");
        assert!(
            found
                .config_schema
                .as_array()
                .is_some_and(|a| a.is_empty()),
            "NULL config_schema must read back as an empty array, not NULL"
        );

        let fetched = get_component("c-legacy-null".to_string())
            .expect("get_component must tolerate NULL json columns");
        assert!(
            fetched.input_schema.as_object().is_some(),
            "input_schema must read back as a valid object (non-null)"
        );
        assert!(
            fetched.output_schema.as_object().is_some(),
            "output_schema must read back as a valid object (non-null)"
        );
        assert!(
            fetched.tags.is_empty(),
            "tags must read back as an empty vec"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    // build_snapshot must merge the component's git config into each node's
    // config so the Python worker reads the truth-source from the frozen plan.
    #[test]
    fn test_build_snapshot_merges_component_git() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        insert_component(&sample_component("c-snap-1")).expect("insert");
        let detail = DagDetail {
            id: "d1".to_string(),
            name: "dag".to_string(),
            description: None,
            status: "draft".to_string(),
            execution_order: None,
            cron: None,
            created_at_ms: 0,
            updated_at_ms: 0,
            nodes: vec![DagNode {
                id: "n1".to_string(),
                dag_id: "d1".to_string(),
                component_id: "c-snap-1".to_string(),
                label: "x".to_string(),
                position: DagNodePosition { x: 0.0, y: 0.0 },
                config: serde_json::json!({}),
            }],
            edges: vec![],
        };
        let snapshot = build_snapshot(&detail).expect("build_snapshot");
        let plan: serde_json::Value = serde_json::from_str(&snapshot).expect("parse snapshot");
        let node_cfg = &plan["nodes"][0]["config"];
        assert_eq!(node_cfg["gitUrl"], "git@github.com:org/repo.git");
        assert_eq!(node_cfg["gitBranch"], "main");
        assert_eq!(node_cfg["gitRef"], "v1.0");
        assert_eq!(node_cfg["entryPoint"], "run.py");

        let _ = std::fs::remove_file(&db_path);
    }

    // Regression: component *names* must be globally unique across the whole
    // `components` table — both registered (global=true) and generic
    // (global=false). A second create with an already-used name is rejected
    // with a friendly business-layer error (not a DB UNIQUE violation). Generic
    // components get a random default name (`generic-component-<suffix>`) on
    // drop, so they
    // never collide in practice, but the guard still counts them.
    #[test]
    fn test_create_component_rejects_duplicate_name() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        // A registered (global=true) component exists with name "X".
        let mut a = sample_component("dup-a");
        a.name = "X".to_string();
        insert_component(&a).expect("insert a");

        // Another registered component with the same name => rejected.
        let mut dup = sample_component("dup-b");
        dup.name = "X".to_string();
        dup.global = true;
        let err = create_component(dup);
        assert!(err.is_err(), "duplicate global name must be rejected");
        assert!(
            err.unwrap_err().contains("同名"),
            "error should mention duplicate name"
        );

        // A generic (global=false) component reusing an existing name must ALSO
        // be rejected now that uniqueness is global.
        let mut g = sample_component("dup-c");
        g.name = "X".to_string();
        g.global = false;
        assert!(
            create_component(g).is_err(),
            "duplicate name must be rejected regardless of global flag"
        );

        // A distinct name (generic or not) is allowed.
        let mut ok = sample_component("dup-d");
        ok.name = "Y".to_string();
        ok.global = false;
        assert!(
            create_component(ok).is_ok(),
            "distinct name must be allowed"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    // Regression: renaming a registered component to its own current name is a
    // no-op (excluded by id); renaming onto another registered component's name
    // is rejected.
    #[test]
    fn test_update_component_rejects_duplicate_global_name() {
        let _guard = DB_TEST_LOCK.lock().unwrap();
        let db_path = with_temp_db();

        let mut a = sample_component("u-a");
        a.name = "alpha".to_string();
        insert_component(&a).expect("insert alpha");
        let mut b = sample_component("u-b");
        b.name = "beta".to_string();
        insert_component(&b).expect("insert beta");

        // rename b -> alpha (collision with a) => rejected
        let mut collide = b.clone();
        collide.name = "alpha".to_string();
        let err = update_component(collide);
        assert!(
            err.is_err(),
            "renaming onto another global name must be rejected"
        );

        // rename b -> beta (its own name) => allowed
        let mut self_rename = b.clone();
        self_rename.name = "beta".to_string();
        assert!(
            update_component(self_rename).is_ok(),
            "renaming to its own current name must be allowed"
        );

        let _ = std::fs::remove_file(&db_path);
    }
}