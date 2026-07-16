import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { initDagServerConfig } from "./app/component-mode/api";
import "./styles.css";

async function bootstrap() {
  // 启动前从磁盘加载 DAG server 配置（~/.agent-ui/dag-mode/dagServer.json），
  // 并自动迁移旧的 localStorage 配置。失败不影响渲染。
  try {
    await initDagServerConfig();
  } catch {
    // ignore — app falls back to "未连接" state
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary label="App">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

bootstrap();
