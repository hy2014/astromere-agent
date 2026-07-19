import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { initDagServerConfig } from "./app/component-mode/api";
import "./styles.css";

async function bootstrap() {
  // Load the DAG server config from disk before startup (~/.agent-ui/dag-mode/dagServer.json),
  // and auto-migrate the legacy localStorage config. Failure does not block rendering.
  try {
    await initDagServerConfig();
  } catch {
    // ignore — app falls back to the "disconnected" state
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
