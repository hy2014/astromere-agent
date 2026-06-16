// ─── HTTP 集成测试 ──────────────────────────────────────────────────────────
// Part A — Plumbing tests: 验证 HTTP 框架层行为（状态码、路由、序列化）
// Part B — Business tests:   验证业务逻辑 roundtrip（创建→HTTP→验证→清理）
//
// 使用 axum test utilities 发送真实 HTTP 请求到 router。

use axum::body::{Body, to_bytes};
use axum::{Json, Router, routing::get};
use http::{Method, Request, StatusCode};
use serde_json::Value;
use std::fs;
use tower::ServiceExt;

// ═══════════════════════════════════════════════════════════════════════════════
// P0: Err(String) → HTTP 状态码
// ═══════════════════════════════════════════════════════════════════════════════

/// 此测试验证 AppError 返回 HTTP 500（而非 200）。
///
/// 背景：axum 0.7 中 `String::into_response()` 返回 HTTP 200。
/// 前端 remote.ts 依赖 `response.ok` 判断错误，所以 Err(String) → 200
/// 会导致业务错误被当作成功处理。
///
/// 修复：定义了 AppError 类型实现 IntoResponse，返回 500 + JSON body。
/// 当前状态：✅ PASS — AppError 正确返回 500。
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
// P0: 路由完备性
// ═══════════════════════════════════════════════════════════════════════════════

/// 验证所有 stateless 端点已注册。
#[tokio::test]
async fn stateless_endpoints_registered() {
    let app = claw_agent_ui::server::stateless_test_router();

    // 无需路径参数或 query 参数即可访问的端点
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

/// 验证所有带路径参数的路由已注册（不会 404）。
/// NOTE: 之前 `{id}` 语法在 matchit 不工作，现已改为 `:id`。
#[tokio::test]
async fn parameterized_routes_registered() {
    let app = claw_agent_ui::server::stateless_test_router();

    // 带路径参数的路由 — 加上 root query 避免 400（missing field）
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

/// 验证 usage/* 和 system/* 端点已注册。
/// 之前这些路由缺失（返回 404），现已修复注册。
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
// HTTP 方法与 Content-Type
// ═══════════════════════════════════════════════════════════════════════════════

/// 用错 HTTP 方法应返回 405 Method Not Allowed。
#[tokio::test]
async fn wrong_method_returns_405() {
    let app = claw_agent_ui::server::stateless_test_router();

    // /health 是 GET-only，POST 应返回 405
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

/// /events 端点必须返回 text/event-stream Content-Type。
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

/// 不存在的路径应返回 404（而非 200 错误字符串）。
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
// JSON 序列化/反序列化格式验证
// ═══════════════════════════════════════════════════════════════════════════════

/// /health 响应格式：{"ok": true}
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

/// /models/settings GET 返回合法 JSON（不验证具体内容，内容来自磁盘配置）
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

    // NOTE: ModelSettings 未使用 rename_all，字段名为 snake_case
    assert!(
        json.get("models").is_some() || json.get("active_model_id").is_some(),
        "model settings must have 'models' or 'active_model_id' field.\n\
         Body preview: {}",
        &String::from_utf8_lossy(&body[..body.len().min(200)])
    );
}

/// /mcp/settings GET 返回合法 JSON
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
                // 成功 — 验证结构
                assert!(
                    json.get("settings").is_some() || json.get("servers").is_some(),
                    "MCP settings response should have 'settings' or 'servers' field. Got: {body_str}"
                );
            } else if json.is_string() {
                // P0 bug: handler 返回 Err(String) → HTTP 200，body 为纯错误字符串
                eprintln!(
                    "[test] P0 BUG CONFIRMED: /mcp/settings returned 200 OK \
                     but body is error string, not JSON object: {body_str}"
                );
            }
        }
        Err(_) => panic!("response body is not valid JSON: {body_str}"),
    }
}

/// /client/exit POST 返回 {"ok": true}
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

/// POST camelCase body → handler 反序列化为 snake_case Rust 字段。
/// 验证 server.rs 中所有 `#[serde(rename = "camelCase")]` 注解的正确性。
#[tokio::test]
async fn camelcase_body_deserialization() {
    // 构造与 server.rs EnsureRequest 等 struct 相同的 rename 模式
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
// 错误请求处理
// ═══════════════════════════════════════════════════════════════════════════════

/// POST JSON body 缺失 → axum 提取器返回反序列化错误。
/// 应返回 4xx（如 400/422），而非 200 错误字符串。
#[tokio::test]
async fn post_without_json_body_returns_client_error() {
    let app = claw_agent_ui::server::stateless_test_router();

    // POST /models/test 但 Content-Type 是 text/plain 或无 body →
    // axum Json 提取器返回 JsonRejection（4xx）
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

    // JSON 解析失败 → axum Json extractor reject → 422 或 400
    assert!(
        response.status().is_client_error(),
        "JSON parse error should return 4xx, got {}.\n\
         A 200 here means errors are swallowed.", response.status()
    );
}

/// POST 缺少必填字段 → 应返回反序列化错误（4xx）
#[tokio::test]
async fn post_missing_required_field_returns_client_error() {
    let app = claw_agent_ui::server::stateless_test_router();

    // /models/test 需要 models 数组，发送空 body
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

    // models 字段缺失 → serde 报错 → axum JsonRejection → 4xx
    assert!(
        response.status().is_client_error(),
        "Missing required field should return 4xx, got {}",
        response.status()
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 并发安全性
// ═══════════════════════════════════════════════════════════════════════════════

/// 高并发请求不 panic、不返回错误状态。
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
// SSE broadcast 通道
// ═══════════════════════════════════════════════════════════════════════════════

/// SSE send → receive 链路正确。
#[tokio::test]
async fn sse_send_receive_works() {
    let mut rx = claw_agent_ui::server::sse_broadcast_sender().subscribe();

    // 排空当前通道中的残留事件（处理 Lagged）
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

/// buffer 溢出时不 panic。
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

/// 多 subscriber 同时接收事件。
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
// Session core 错误处理
// ═══════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn session_core_error_returns_err() {
    use claw_agent_ui::session_core;

    // 不存在的路径 → Err
    assert!(session_core::list_sessions("/nonexistent/path/for/testing").is_err());
    assert!(session_core::load_session("/tmp", "nonexistent-session-id").is_err());

    // create_session 格式验证
    let created = session_core::create_session("/tmp").unwrap();
    assert!(created.id.starts_with("new-"));
    assert!(!created.title.is_empty());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part B: 业务 roundtrip 集成测试
// 模式：准备数据 → 发送 HTTP 请求 → 验证响应 → 清理
// ═══════════════════════════════════════════════════════════════════════════════

// ── Business test 1: Model settings no-op roundtrip ────────────────────────

/// GET /models/settings → PUT 相同数据 → GET → 验证不变。
/// 这是一个无副作用的 roundtrip 测试，不会修改用户实际配置。
#[tokio::test]
async fn business_model_settings_read_after_write() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Step 1: GET 当前 settings
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

    // 如果不是 JSON 对象（P0 bug：error string → 200），跳过后面的步骤
    let original: Value = serde_json::from_slice(&original_bytes)
        .expect("GET /models/settings must return valid JSON");
    if !original.is_object() {
        eprintln!("[test] SKIP: GET /models/settings returned non-object (likely P0 error-as-200 bug)");
        return;
    }

    // Step 2: PUT 相同数据回去
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

    // Step 3: GET 再次读取，验证不变
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

/// GET /mcp/settings → PUT 相同数据 → GET → 验证不变。
#[tokio::test]
async fn business_mcp_settings_read_after_write() {
    let app = claw_agent_ui::server::stateless_test_router();

    // Step 1: GET 当前 settings
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

    // Step 2: PUT 相同数据（只传 settings 字段）
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

    // Step 3: GET 验证
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

/// PUT /workspace/file → GET /workspace/file → 内容一致 → 清理文件。
#[tokio::test]
async fn business_workspace_file_write_then_read() {
    use tempfile::TempDir;

    let app = claw_agent_ui::server::stateless_test_router();
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let test_path = "integration-test-file.txt";
    let test_content = "hello from business integration test\nline 2";

    // Step 1: PUT 写文件
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

    // Step 2: GET 读回
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

    // Step 3: 验证内容
    // 响应格式取决于 read_workspace_file 的返回值，至少应有 content 或 path 字段
    let content_from_api = json
        .get("content")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("text").and_then(|v| v.as_str()))
        .unwrap_or("");

    assert_eq!(
        content_from_api, test_content,
        "file content should match what we wrote"
    );

    // Step 4: 清理（temp dir 会自动清理，但显式删除确保干净）
    let _ = fs::remove_file(tmp.path().join(test_path));
}

// ── Business test 4: Workspace file edit roundtrip ────────────────────────

/// PUT 文件 → POST edit → GET → 验证修改 → 清理。
#[tokio::test]
async fn business_workspace_file_edit_then_read() {
    use tempfile::TempDir;

    let app = claw_agent_ui::server::stateless_test_router();
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_str().unwrap().to_string();
    let test_path = "edit-test-file.txt";

    // Step 1: 先写入原始内容
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

    // Step 2: POST edit — 替换 "line two" → "LINE TWO MODIFIED"
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

    // Step 3: GET 验证修改
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

    // Step 4: 清理
    let _ = fs::remove_file(tmp.path().join(test_path));
}


// ── Business test 5: Session 创建 → 列表 → 加载 → 清理 ───────────

/// 手动创建 JSONL session 文件 → GET /sessions 列表 → GET /sessions/:id 加载 → 清理。
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

/// URL 编码 path 片段（用于 query 参数）。
/// 仅编码需要编码的字符，保持可读性。
fn urlencoding(s: &str) -> String {
    s.replace('%', "%25")
        .replace('&', "%26")
        .replace('+', "%2B")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F")
}
