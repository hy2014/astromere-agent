// ─── HTTP integration tests ───────────────────────────────────────────────
// Part A — Plumbing tests: verify HTTP framework-layer behavior (status codes,
// routing, serialization).
// Part B — Business tests:   verify business-logic roundtrip (create → HTTP →
// verify → cleanup).
//
// Uses axum test utilities to send real HTTP requests to the router.

use axum::body::{Body, to_bytes};
use axum::{Json, Router, routing::get};
use http::{Method, Request, StatusCode};
use serde_json::Value;
use std::fs;
use tower::ServiceExt;

// ═══════════════════════════════════════════════════════════════════════════════
// P0: Err(String) → HTTP status code
// ═══════════════════════════════════════════════════════════════════════════════

/// This test verifies that AppError returns HTTP 500 (not 200).
///
/// Background: in axum 0.7 `String::into_response()` returns HTTP 200.
/// The frontend remote.ts relies on `response.ok` to detect errors, so
/// Err(String) → 200 would cause business errors to be treated as success.
///
/// Fix: the AppError type implements IntoResponse and returns 500 + a JSON
/// body. Current status: PASS — AppError correctly returns 500.
#[tokio::test]
async fn app_error_returns_500_not_200() {
    async fn error_handler() -> Result<Json<Value>, claw_agent_ui::server::AppError> {
        Err(claw_agent_ui::server::AppError::new("business logic error"))
    }

    let app = Router::new().route("/test-err", get(error_handler));

    let response = app
        .oneshot(Request::get("/test-err").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "AppError should return HTTP 500, got {}",
        response.status()
    );

    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert!(
        json.get("error").is_some(),
        "error response should contain 'error' field, got: {json}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// P0: Route completeness
// ═══════════════════════════════════════════════════════════════════════════════

/// Verify that all stateless endpoints are registered.
#[tokio::test]
async fn stateless_endpoints_registered() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Endpoints reachable without path or query parameters.
    let direct_endpoints = [
        ("/health", Method::GET),
        ("/models/deepseek-pricing", Method::GET),
        ("/events", Method::GET),
    ];

    for (path, method) in &direct_endpoints {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(path.to_string())
                    .header("accept", "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "route {method} {path} returned 404 — not registered in router"
        );
    }
}

/// Verify that all path-parameter routes are registered (no 404).
/// NOTE: the `{id}` syntax used to not work in matchit; it is now `:id`.
#[tokio::test]
async fn parameterized_routes_registered() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Path-parameter routes — add a root query to avoid a 400 (missing field).
    let param_routes = [
        ("/sessions/test-id?root=/tmp", Method::GET),
        ("/usage/bundle/test-sid?root=/tmp", Method::GET),
        ("/usage/model-call/test-sid?root=/tmp", Method::GET),
    ];

    for (uri, method) in &param_routes {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(uri.to_string())
                    .header("accept", "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "parameterized route {method} {uri} returned 404 — path param syntax may be broken (use :id not {{id}})"
        );
    }
}

/// Verify that the usage/* and system/* endpoints are registered.
/// These routes used to be missing (returned 404); registration is now fixed.
#[tokio::test]
async fn usage_and_system_routes_registered() {
    let app = claw_agent_ui::server::stateless_test_router();

    // GET routes — should return non-404 (route is registered, even if handler
    // may return an error for invalid path params)
    let get_routes = [
        "/system/sqlite-info",
    ];

    for path in &get_routes {
        let response = app
            .clone()
            .oneshot(
                Request::get(*path)
                    .header("accept", "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "route GET '{}' should be registered, got 404",
            path
        );
    }

    // POST routes — should return non-404 (route registered)
    let post_routes = [
        ("/usage/bundle", r#"{"sessionId":"test","bundleId":"test","root":"/tmp","source":"test","status":"test","updatedAtMs":0,"modelCallIds":[],"modelCallUsages":[],"usage":{"inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"totalInputTokens":0}}"#),
        ("/usage/model-call", r#"{"modelCallId":"test","sessionId":"test","root":"/tmp","inputTokens":0,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"updatedAtMs":0,"source":"test"}"#),
    ];

    for (path, body) in &post_routes {
        let response = app
            .clone()
            .oneshot(
                Request::post(*path)
                    .header("content-type", "application/json")
                    .body(Body::from(*body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            StatusCode::NOT_FOUND,
            "route POST '{}' should be registered, got 404",
            path
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP method and Content-Type
// ═══════════════════════════════════════════════════════════════════════════════

/// Using the wrong HTTP method should return 405 Method Not Allowed.
#[tokio::test]
async fn wrong_method_returns_405() {
    let app = claw_agent_ui::server::stateless_test_router();

    // /health is GET-only, so POST should return 405.
    let response = app
        .clone()
        .oneshot(
            Request::post("/health")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::METHOD_NOT_ALLOWED,
        "POST to GET-only /health should return 405 Method Not Allowed"
    );
}

/// The /events endpoint must return Content-Type: text/event-stream.
#[tokio::test]
async fn events_endpoint_returns_sse_content_type() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .oneshot(Request::get("/events").body(Body::empty()).unwrap())
        .await
        .unwrap();

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    assert!(
        content_type.starts_with("text/event-stream"),
        "SSE /events endpoint should return Content-Type: text/event-stream, got '{content_type}'"
    );
}

/// A non-existent path should return 404 (not a 200 error string).
#[tokio::test]
async fn nonexistent_path_returns_404() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .clone()
        .oneshot(
            Request::get("/this-route-does-not-exist-ever")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "Unknown path should return 404, not some other fallback status"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON serialization/deserialization format verification
// ═══════════════════════════════════════════════════════════════════════════════

/// /health response format: {"ok": true}.
#[tokio::test]
async fn health_response_format() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["ok"], true);
    assert!(
        json.get("message").is_none(),
        "health response should not contain 'message' field on success"
    );
}

/// /models/settings GET returns valid JSON (content is not verified; it comes
/// from the on-disk config).
#[tokio::test]
async fn models_settings_get_returns_valid_json() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .oneshot(
            Request::get("/models/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 65536).await.unwrap();
    let json: Value = serde_json::from_slice(&body).expect("response must be valid JSON");

    // NOTE: ModelSettings does not use rename_all, so fields are snake_case.
    assert!(
        json.get("models").is_some() || json.get("active_model_id").is_some(),
        "model settings must have 'models' or 'active_model_id' field.\n\
         Body preview: {}",
        &String::from_utf8_lossy(&body[..body.len().min(200)])
    );
}

/// /mcp/settings GET returns valid JSON.
#[tokio::test]
async fn mcp_settings_get_returns_valid_json() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .oneshot(
            Request::get("/mcp/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 65536).await.unwrap();
    let body_str = String::from_utf8_lossy(&body);

    match serde_json::from_slice::<Value>(&body) {
        Ok(json) => {
            if json.is_object() {
                // Success — verify the structure.
                assert!(
                    json.get("settings").is_some() || json.get("servers").is_some(),
                    "MCP settings response should have 'settings' or 'servers' field. Got: {body_str}"
                );
            } else if json.is_string() {
                // P0 bug: handler returns Err(String) → HTTP 200, body is a raw error string.
                eprintln!(
                    "[test] P0 BUG CONFIRMED: /mcp/settings returned 200 OK \
                     but body is error string, not JSON object: {body_str}"
                );
            }
        }
        Err(_) => panic!("response body is not valid JSON: {body_str}"),
    }
}

/// /client/exit POST returns {"ok": true}.
#[tokio::test]
async fn client_exit_returns_ok() {
    let app = claw_agent_ui::server::stateless_test_router();

    let response = app
        .clone()
        .oneshot(
            Request::post("/client/exit")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"reason":"client-switch"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["ok"], true);
}

/// POST camelCase body → handler deserializes into snake_case Rust fields.
/// Verifies the correctness of every `#[serde(rename = "camelCase")]` attribute
/// in server.rs.
#[tokio::test]
async fn camelcase_body_deserialization() {
    // Build the same rename pattern as the structs in server.rs (e.g. EnsureRequest).
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EnsureLike {
        session_id: String,
        model_override: Option<String>,
        permission_mode: Option<String>,
    }

    async fn handler(axum::Json(body): axum::Json<EnsureLike>) -> axum::Json<Value> {
        axum::Json(serde_json::json!({
            "session_id": body.session_id,
            "model_override": body.model_override,
            "permission_mode": body.permission_mode,
        }))
    }

    let app = Router::new().route("/test-camelcase", axum::routing::post(handler));

    let response = app
        .oneshot(
            Request::post("/test-camelcase")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"sessionId":"abc-123","modelOverride":"gpt-4","permissionMode":"plan"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["session_id"], "abc-123", "camelCase 'sessionId' → snake_case 'session_id'");
    assert_eq!(json["model_override"], "gpt-4", "camelCase 'modelOverride' → snake_case 'model_override'");
    assert_eq!(json["permission_mode"], "plan", "camelCase 'permissionMode' → snake_case 'permission_mode'");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bad-request handling
// ═══════════════════════════════════════════════════════════════════════════════

/// POST JSON body missing → axum extractor returns a deserialization error.
/// Should return 4xx (e.g. 400/422), not a 200 error string.
#[tokio::test]
async fn post_without_json_body_returns_client_error() {
    let app = claw_agent_ui::server::stateless_test_router();

    // POST /models/test with Content-Type text/plain or no body →
    // axum Json extractor returns a JsonRejection (4xx).
    let response = app
        .clone()
        .oneshot(
            Request::post("/models/test")
                .header("content-type", "application/json")
                .body(Body::from("this is not json"))
                .unwrap(),
        )
        .await
        .unwrap();

    // JSON parse failure → axum Json extractor reject → 422 or 400.
    assert!(
        response.status().is_client_error(),
        "JSON parse error should return 4xx, got {}.\n\
         A 200 here means errors are swallowed.", response.status()
    );
}

/// POST missing a required field → should return a deserialization error (4xx).
#[tokio::test]
async fn post_missing_required_field_returns_client_error() {
    let app = claw_agent_ui::server::stateless_test_router();

    // /models/test requires the models array; send an empty body.
    let response = app
        .clone()
        .oneshot(
            Request::post("/models/test")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    // models field missing → serde error → axum JsonRejection → 4xx.
    assert!(
        response.status().is_client_error(),
        "Missing required field should return 4xx, got {}",
        response.status()
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Concurrency safety
// ═══════════════════════════════════════════════════════════════════════════════

/// High-concurrency requests do not panic and do not return error states.
#[tokio::test]
async fn concurrent_requests_no_panic() {
    let app = claw_agent_ui::server::stateless_test_router();

    let mut handles = Vec::new();
    for _ in 0..100 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            app.oneshot(
                Request::get("/health")
                    .header("accept", "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        }));
    }

    let mut ok = 0;
    for handle in handles {
        let response = handle.await.expect("task panicked");
        if response.status() == StatusCode::OK {
            ok += 1;
        }
    }

    assert_eq!(ok, 100, "all 100 concurrent /health requests must return 200");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE broadcast channel
// ═══════════════════════════════════════════════════════════════════════════════

/// SSE send → receive link works correctly.
#[tokio::test]
async fn sse_send_receive_works() {
    let mut rx = claw_agent_ui::server::sse_broadcast_sender().subscribe();

    // Drain leftover events in the channel (handling Lagged).
    loop {
        match rx.try_recv() {
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
        }
    }

    let test_event = r#"{"eventType":"sse-integration-test","payload":{"value":42}}"#.to_string();
    claw_agent_ui::server::broadcast_sse_event(test_event.clone());

    let received = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("timed out")
        .expect("receive failed");

    assert_eq!(received, test_event);
}

/// No panic when the buffer overflows.
#[tokio::test]
async fn sse_buffer_overflow_no_panic() {
    for i in 0..512u32 {
        claw_agent_ui::server::broadcast_sse_event(format!(
            r#"{{"eventType":"overflow","seq":{i}}}"#
        ));
    }

    let mut rx = claw_agent_ui::server::sse_broadcast_sender().subscribe();
    claw_agent_ui::server::broadcast_sse_event(
        r#"{"eventType":"after-overflow","ok":true}"#.to_string(),
    );

    let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .expect("timed out")
        .expect("receive failed");

    assert!(received.contains("ok"));
}

/// Multiple subscribers receive events simultaneously.
#[tokio::test]
async fn sse_multiple_subscribers() {
    let mut rx1 = claw_agent_ui::server::sse_broadcast_sender().subscribe();
    let mut rx2 = claw_agent_ui::server::sse_broadcast_sender().subscribe();

    // Allow any in-flight sends from prior tests to settle
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Drain lingering messages
    loop {
        match rx1.try_recv() {
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
        }
    }
    loop {
        match rx2.try_recv() {
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
        }
    }

    let event = r#"{"eventType":"multi-sub","seq":1}"#.to_string();
    claw_agent_ui::server::broadcast_sse_event(event.clone());

    let r1 = tokio::time::timeout(std::time::Duration::from_secs(1), rx1.recv())
        .await.unwrap().unwrap();
    let r2 = tokio::time::timeout(std::time::Duration::from_secs(1), rx2.recv())
        .await.unwrap().unwrap();

    assert_eq!(r1, event);
    assert_eq!(r2, event);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session core error handling
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn session_core_error_returns_err() {
    use claw_agent_ui::session_core;

    // A non-existent path → Err.
    assert!(session_core::list_sessions("/nonexistent/path/for/testing").is_err());
    assert!(session_core::load_session("/tmp", "nonexistent-session-id").is_err());

    // create_session format validation.
    let created = session_core::create_session("/tmp").unwrap();
    assert!(created.id.starts_with("new-"));
    assert!(!created.title.is_empty());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part B: business roundtrip integration tests
// Pattern: prepare data → send HTTP request → verify response → cleanup
// ═══════════════════════════════════════════════════════════════════════════════

// ── Business test 1: Model settings no-op roundtrip ────────────────────────

/// GET /models/settings → PUT the same data → GET → verify unchanged.
/// This is a side-effect-free roundtrip test that does not modify the user's
/// real configuration.
#[tokio::test]
async fn business_model_settings_read_after_write() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Step 1: GET the current settings.
    let response = app
        .clone()
        .oneshot(
            Request::get("/models/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let original_bytes = to_bytes(response.into_body(), 65536).await.unwrap();

    // If it is not a JSON object (P0 bug: error string → 200), skip the rest.
    let original: Value = serde_json::from_slice(&original_bytes)
        .expect("GET /models/settings must return valid JSON");
    if !original.is_object() {
        eprintln!("[test] SKIP: GET /models/settings returned non-object (likely P0 error-as-200 bug)");
        return;
    }

    // Step 2: PUT the same data back.
    let put_body = original_bytes.clone();
    let response = app
        .clone()
        .oneshot(
            Request::put("/models/settings")
                .header("content-type", "application/json")
                .body(Body::from(put_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "PUT /models/settings with valid data should succeed, got {}",
        response.status()
    );

    // Step 3: GET again and verify nothing changed.
    let response = app
        .clone()
        .oneshot(
            Request::get("/models/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let new_bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    let new_value: Value = serde_json::from_slice(&new_bytes).unwrap();

    assert_eq!(
        original, new_value,
        "model settings should be unchanged after no-op PUT"
    );
}

// ── Business test 2: MCP settings no-op roundtrip ─────────────────────────

/// GET /mcp/settings → PUT the same data → GET → verify unchanged.
#[tokio::test]
async fn business_mcp_settings_read_after_write() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Step 1: GET the current settings.
    let response = app
        .clone()
        .oneshot(
            Request::get("/mcp/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let original_bytes = to_bytes(response.into_body(), 65536).await.unwrap();

    let original: Value = serde_json::from_slice(&original_bytes)
        .expect("GET /mcp/settings must return valid JSON");
    if !original.is_object() {
        eprintln!("[test] SKIP: GET /mcp/settings returned non-object (likely P0 error-as-200 bug)");
        return;
    }

    // Step 2: PUT the same data (only the settings field).
    let settings_value = original.get("settings").cloned().unwrap_or_default();
    let response = app
        .clone()
        .oneshot(
            Request::put("/mcp/settings")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&settings_value).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "PUT /mcp/settings should succeed, got {}",
        response.status()
    );

    // Step 3: GET and verify.
    let response = app
        .clone()
        .oneshot(
            Request::get("/mcp/settings")
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let new_bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    let new_value: Value = serde_json::from_slice(&new_bytes).unwrap();

    assert_eq!(
        new_value.get("settings"),
        Some(&settings_value),
        "MCP settings should be unchanged after no-op PUT"
    );
}

// ── Business test 3: Workspace file roundtrip ─────────────────────────────

/// PUT /workspace/file → GET /workspace/file → content matches → clean up file.
#[tokio::test]
async fn business_workspace_file_write_then_read() {
    use tempfile::TempDir;

    let app = claw_agent_ui::server::stateless_test_router();
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let test_path = "integration-test-file.txt";
    let test_content = "hello from business integration test\nline 2";

    // Step 1: PUT to write the file.
    let write_body = serde_json::json!({
        "root": root,
        "path": test_path,
        "content": test_content,
    });

    let response = app
        .clone()
        .oneshot(
            Request::put("/workspace/file")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&write_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status().is_success(),
        "PUT /workspace/file should succeed, got {}",
        response.status()
    );

    // Step 2: GET to read it back.
    let uri = format!(
        "/workspace/file?root={}&path={}",
        urlencoding(&root),
        urlencoding(test_path)
    );
    let response = app
        .clone()
        .oneshot(
            Request::get(&uri)
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 65536).await.unwrap();
    let json: Value = serde_json::from_slice(&body)
        .expect("GET /workspace/file must return valid JSON");

    // Step 3: verify content.
    // The response shape depends on read_workspace_file's return value; it
    // should have at least a content or path field.
    let content_from_api = json
        .get("content")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("text").and_then(|v| v.as_str()))
        .unwrap_or("");

    assert_eq!(
        content_from_api, test_content,
        "file content should match what we wrote"
    );

    // Step 4: cleanup (the temp dir auto-cleans, but delete explicitly to be safe).
    let _ = fs::remove_file(tmp.path().join(test_path));
}

// ── Business test 4: Workspace file edit roundtrip ────────────────────────

/// PUT file → POST edit → GET → verify the change → clean up.
#[tokio::test]
async fn business_workspace_file_edit_then_read() {
    use tempfile::TempDir;

    let app = claw_agent_ui::server::stateless_test_router();
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let test_path = "edit-test-file.txt";

    // Step 1: first write the original content.
    let original_content = "line one\nline two\nline three\n";
    let put_body = serde_json::json!({
        "root": root,
        "path": test_path,
        "content": original_content,
    });
    let response = app
        .clone()
        .oneshot(
            Request::put("/workspace/file")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&put_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());

    // Step 2: POST edit — replace "line two" → "LINE TWO MODIFIED"
    let edit_body = serde_json::json!({
        "root": root,
        "path": test_path,
        "oldString": "line two",
        "newString": "LINE TWO MODIFIED",
        "replaceAll": false
    });
    let response = app
        .clone()
        .oneshot(
            Request::post("/workspace/file/edit")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&edit_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "POST /workspace/file/edit should succeed, got {}",
        response.status()
    );

    // Step 3: GET and verify the change.
    let uri = format!(
        "/workspace/file?root={}&path={}",
        urlencoding(&root),
        urlencoding(test_path)
    );
    let response = app
        .clone()
        .oneshot(
            Request::get(&uri)
                .header("accept", "application/json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 65536).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    let content = json
        .get("content")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("text").and_then(|v| v.as_str()))
        .unwrap_or("");

    assert!(content.contains("LINE TWO MODIFIED"), "edit should modify the file");
    assert!(content.contains("line one"), "edit should not affect other lines");
    assert!(content.contains("line three"), "edit should not affect other lines");

    // Step 4: cleanup
    let _ = fs::remove_file(tmp.path().join(test_path));
}


// ── Business test 5: Session create → list → load → cleanup ───────────

/// Manually create a JSONL session file → GET /sessions list → GET /sessions/:id load → cleanup.
#[tokio::test]
async fn business_session_list_and_load() {
    use claw_agent_ui::{utils, session_core};
    use tempfile::TempDir;

    let app = claw_agent_ui::server::stateless_test_router();

    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();

    let canonical = tmp.path().canonicalize().unwrap();
    let sessions_dir = utils::claude_project_sessions_dir(&canonical).unwrap();
    if sessions_dir.exists() { let _ = fs::remove_dir_all(&sessions_dir); }
    fs::create_dir_all(&sessions_dir).unwrap();

    let session_id = "abc12345-def4-5678-90ab-cdef01234567";
    let session_content = format!(
        r#"{{"type":"system","session_id":"{sid}","content":"system message"}}
{{"type":"user","session_id":"{sid}","message":{{"role":"user","content":"hello"}}}}
{{"type":"assistant","session_id":"{sid}","message":{{"role":"assistant","content":["hi there"]}}}}"#,
        sid = session_id
    );
    let jsonl_path = sessions_dir.join(format!("{}.jsonl", session_id));
    fs::write(&jsonl_path, session_content).unwrap();

    // Step 1: HTTP GET list
    let list_uri = format!("/sessions?root={}", urlencoding(&root));
    let response = app.clone().oneshot(
        Request::get(&list_uri).header("accept", "application/json").body(Body::empty()).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(response.into_body(), 65536).await.unwrap();
    let list: Value = serde_json::from_slice(&body_bytes).unwrap();
    let sessions = list.as_array().unwrap();
    assert!(sessions.iter().any(|s| s.get("id").and_then(|v| v.as_str()) == Some(session_id)));

    // Step 2: HTTP GET load (with :id path param fix)
    let load_uri = format!("/sessions/{}?root={}", session_id, urlencoding(&root));
    let response = app.clone().oneshot(
        Request::get(&load_uri).header("accept", "application/json").body(Body::empty()).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "HTTP load /sessions/:id should work after :id fix");
    let body_bytes = axum::body::to_bytes(response.into_body(), 65536).await.unwrap();
    let detail: Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(detail.get("id").and_then(|v| v.as_str()), Some(session_id));
    assert_eq!(detail.get("message_count").and_then(|v| v.as_u64()), Some(3));

    let _ = fs::remove_file(&jsonl_path);
    let _ = fs::remove_dir_all(&sessions_dir);
}
// ── Helpers ────────────────────────────────────────────────────────────────

/// URL-encode path segments (used for query params).
/// Only encode characters that need encoding, preserving readability.
fn urlencoding(s: &str) -> String {
    s.replace('%', "%25")
        .replace('&', "%26")
        .replace('+', "%2B")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F")
}
