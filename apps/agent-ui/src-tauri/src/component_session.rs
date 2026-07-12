//! Manages associations between components and their Code-mode sessions.

use crate::components::get_component;
use crate::sqlite::open_sqlite_database;
use crate::types::ComponentSession;
use crate::utils::{
    claude_project_sessions_dir, generate_agent_ui_session_id, now_millis,
};
use rusqlite::params;
use std::fs;
use std::path::Path;

fn error_to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn row_to_component_session(row: &rusqlite::Row) -> Result<ComponentSession, rusqlite::Error> {
    Ok(ComponentSession {
        id: row.get("id")?,
        component_id: row.get("component_id")?,
        session_id: row.get("session_id")?,
        session_path: row.get("session_path")?,
        title: row.get("title")?,
        created_at_ms: row.get("created_at_ms")?,
        updated_at_ms: row.get("updated_at_ms")?,
    })
}

fn compute_session_path(component_id: &str, session_id: &str) -> Result<String, String> {
    // Session files are anchored to the component identity (component_id) now
    // that workspace_root is deprecated. The Claude projects dir keys sessions
    // by a sanitized project path, so we use component_id as that key.
    let root = Path::new(component_id);
    let sessions_dir = claude_project_sessions_dir(root)?;
    fs::create_dir_all(&sessions_dir).map_err(error_to_string)?;
    let path = sessions_dir.join(format!("{session_id}.jsonl"));
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn create_component_session(
    component_id: String,
    title: Option<String>,
) -> Result<ComponentSession, String> {
    let component = get_component(component_id.clone())?;
    let session_id = generate_agent_ui_session_id();
    let session_path = compute_session_path(&component.id, &session_id)?;
    let now = now_millis() as i64;

    let session = ComponentSession {
        id: generate_agent_ui_session_id(),
        component_id,
        session_id,
        session_path,
        title: title.or_else(|| Some("New session".to_string())),
        created_at_ms: now,
        updated_at_ms: now,
    };

    insert_component_session(&session)?;
    Ok(session)
}

pub fn insert_component_session(session: &ComponentSession) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    conn.execute(
        "INSERT INTO component_sessions (id, component_id, session_id, session_path, title, \
         created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session.id,
            session.component_id,
            session.session_id,
            session.session_path,
            session.title,
            session.created_at_ms,
            session.updated_at_ms,
        ],
    )
    .map_err(error_to_string)?;
    Ok(())
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn list_component_sessions(component_id: String) -> Result<Vec<ComponentSession>, String> {
    let (conn, _path) = open_sqlite_database()?;
    let mut statement = conn
        .prepare(
            "SELECT id, component_id, session_id, session_path, title, created_at_ms, \
             updated_at_ms FROM component_sessions \
             WHERE component_id = ?1 AND deleted_at_ms IS NULL \
             ORDER BY updated_at_ms DESC",
        )
        .map_err(error_to_string)?;

    let rows = statement
        .query_map(params![component_id], row_to_component_session)
        .map_err(error_to_string)?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(error_to_string)?);
    }
    Ok(sessions)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn update_component_session_title(
    session_id: String,
    title: String,
) -> Result<ComponentSession, String> {
    let (conn, _path) = open_sqlite_database()?;
    let updated_at_ms = now_millis() as i64;
    conn.execute(
        "UPDATE component_sessions SET title = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![session_id, title, updated_at_ms],
    )
    .map_err(error_to_string)?;

    let mut statement = conn
        .prepare(
            "SELECT id, component_id, session_id, session_path, title, created_at_ms, \
             updated_at_ms FROM component_sessions WHERE id = ?1",
        )
        .map_err(error_to_string)?;

    let session = statement
        .query_row(params![session_id], row_to_component_session)
        .map_err(error_to_string)?;
    Ok(session)
}

#[cfg_attr(feature = "gui", tauri::command)]
pub fn delete_component_session(session_id: String) -> Result<(), String> {
    let (conn, _path) = open_sqlite_database()?;
    // Soft delete: only mark the row, keep the Code-mode .jsonl session file intact.
    conn.execute(
        "UPDATE component_sessions SET deleted_at_ms = ?2 WHERE id = ?1",
        params![session_id, now_millis() as i64],
    )
    .map_err(error_to_string)?;
    Ok(())
}
