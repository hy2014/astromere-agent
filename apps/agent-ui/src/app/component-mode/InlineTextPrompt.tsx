import {useEffect, useRef, useState} from "react";

export type InlineTextPromptProps = {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** When true (default), an empty value blocks submit and shows an inline error. */
  require?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
};

/**
 * A small inline text-input popover used instead of `window.prompt`, which is
 * a no-op inside the Tauri WebView. Enter confirms, Escape cancels.
 */
export function InlineTextPrompt({
  title,
  label,
  defaultValue = "",
  placeholder,
  confirmLabel = "OK",
  require = true,
  onConfirm,
  onCancel,
}: InlineTextPromptProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (require && !trimmed) {
      setError("This field is required");
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div className="inline-prompt">
      <div className="inline-prompt-title">{title}</div>
      {label && <label className="inline-prompt-label">{label}</label>}
      <input
        ref={inputRef}
        className="inline-prompt-input"
        value={value}
        placeholder={placeholder ?? label}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") onCancel();
        }}
      />
      {error && <div className="inline-prompt-error">{error}</div>}
      <div className="inline-prompt-actions">
        <button type="button" className="inline-prompt-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="inline-prompt-ok" onClick={submit}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
