import React from "react";

interface Props {
  onClose: () => void;
}

export function RemoteTerminalPlaceholder({ onClose }: Props) {
  return (
    <div className="terminal-placeholder">
      <div className="terminal-placeholder-content">
        <div className="terminal-placeholder-icon">⌘</div>
        <h2>Remote Terminal Not Supported</h2>
        <p>
          The remote runtime does not support an interactive terminal yet.
          Use the local runtime for full terminal access.
        </p>
      </div>
    </div>
  );
}
