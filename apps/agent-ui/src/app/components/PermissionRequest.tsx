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

export function PermissionRequest({ permission, onAllow, onDeny }: PermissionRequestProps) {
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
        <button
          type="button"
          className="permission-allow-button"
          onClick={onAllow}
        >
          允许
        </button>
        <button
          type="button"
          className="permission-deny-button"
          onClick={onDeny}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
