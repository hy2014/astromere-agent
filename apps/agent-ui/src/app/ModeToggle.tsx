import type {AppMode} from "./types";
import "./ModeToggle.css";

export type ModeToggleProps = {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
};

export function ModeToggle({mode, onChange}: ModeToggleProps) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="Application mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "code"}
        className={`mode-toggle-option ${mode === "code" ? "active" : ""}`}
        onClick={() => onChange("code")}
      >
        Code
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "dag"}
        className={`mode-toggle-option ${mode === "dag" ? "active" : ""}`}
        onClick={() => onChange("dag")}
      >
        DAG
      </button>
      <span className={`mode-toggle-thumb ${mode}`} aria-hidden="true" />
    </div>
  );
}
