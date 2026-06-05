/* @checkFns permission-request */
import {render} from "../../core/dep";

interface PendingPermission {
  root: string;
  sessionId: string;
  messageId: string;
  requestId: string;
  prompt: string;
  toolName?: string;
  input?: unknown;
  rawJson?: unknown;
}

interface PermissionRequestProps {
  permission: PendingPermission;
  onAllow: () => void;
  onDeny: () => void;
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const candidate =
    obj.file_path ??
    obj.filePath ??
    obj.path;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function renderPermissionRequestCard(
  {}: Record<string, never>,
  {permission}: { permission: PendingPermission },
  {onAllow, onDeny}: { onAllow: () => void; onDeny: () => void },
): JSX.Element {
  const filePath = extractFilePath(permission.input);

  return (
    <div className="permission-request">
      <div className="permission-request-topline">
        <div className="permission-request-icon">!</div>
        <div className="permission-request-copy">
          <strong>需要授权</strong>
          <span className="permission-tool-name">{permission.toolName ?? "tool"}</span>
        </div>
      </div>
      <div className="permission-prompt">{permission.prompt}</div>
      {filePath ? (
        <div className="permission-file-path-row">
          <span className="permission-file-path-icon">📄</span>
          <span className="permission-file-path-value">{filePath}</span>
        </div>
      ) : null}
      <details className="permission-request-details">
        <summary>查看详情</summary>
        <pre>
          {(() => {
            const input = permission.input;
            if (!input) return "—";
            if (typeof input === "string") return input;
            try { return JSON.stringify(input, null, 2); }
            catch { return String(input); }
          })()}
        </pre>
      </details>
      <div className="permission-request-actions">
        <button type="button" className="permission-allow-button" onClick={onAllow}>
          允许
        </button>
        <button type="button" className="permission-deny-button" onClick={onDeny}>
          拒绝
        </button>
      </div>
    </div>
  );
}

export function PermissionRequestView({permission, onAllow, onDeny}: PermissionRequestProps) {
  return render({
    state: {},
    props: {permission, onAllow, onDeny},
    fn: renderPermissionRequestCard,
    events: {onAllow, onDeny},
  });
}
