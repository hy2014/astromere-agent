/* @checkFns ask-question-card */
import {useState} from "react";
import {render} from "../../core/dep";

interface AskQuestionPermission {
  root: string;
  sessionId: string;
  messageId: string;
  requestId: string;
  prompt: string;
  toolName?: string;
  input?: unknown;
  isQuestion?: boolean;
  questions?: Array<{
    question: string;
    header?: string;
    options: Array<{label: string; description?: string}>;
    multiSelect?: boolean;
  }>;
}

interface AskQuestionCardProps {
  permission: AskQuestionPermission;
  onConfirm: (answers?: Record<string, string>) => void;
  onCancel: () => void;
}

// ─── WriteState ─────────────────────────────────────────────────────────
const WriteState: {
  setSelected: (s: Record<string, string | Set<string>> | ((prev: Record<string, string | Set<string>>) => Record<string, string | Set<string>>)) => void;
} = {} as any;

// ─── File-level business functions ──────────────────────────────────────

function initSelected(
  question: any,
  multi: boolean,
  key: string,
): Record<string, string | Set<string>> {
  if (!question) return {};
  if (multi) return {[key]: new Set<string>()};
  return {};
}

function handleOptionSelect(
  key: string,
  label: string,
  multi: boolean,
): void {
  if (multi) {
    WriteState.setSelected((prev) => {
      const set = new Set(prev[key] instanceof Set ? (prev[key] as Set<string>) : undefined);
      if (set.has(label)) {
        set.delete(label);
      } else {
        set.add(label);
      }
      return {...prev, [key]: set};
    });
  } else {
    WriteState.setSelected({[key]: label});
  }
}

function handleConfirmAction(
  selected: Record<string, string | Set<string>>,
  key: string,
  multi: boolean,
  onConfirm: (answers?: Record<string, string>) => void,
): void {
  const entry = selected[key];
  if (multi && entry instanceof Set) {
    const labels = [...entry];
    if (labels.length === 0) return;
    onConfirm({[key]: labels.join(", ")});
  } else if (typeof entry === "string") {
    onConfirm({[key]: entry});
  }
}

function checkSelected(
  selected: Record<string, string | Set<string>>,
  key: string,
  multi: boolean,
  label: string,
): boolean {
  const entry = selected[key];
  if (multi && entry instanceof Set) return entry.has(label);
  return entry === label;
}

function handleCancel(onCancel: () => void): void {
  onCancel();
}

function isDisabled(
  selected: Record<string, string | Set<string>>,
  key: string,
  multi: boolean,
): boolean {
  if (multi) {
    return !(selected[key] instanceof Set && (selected[key] as Set<string>).size > 0);
  }
  return !selected[key];
}

// ─── renderFn functions ───────────────────────────────────────────────

function renderAskQuestionCard(
  {selected}: { selected: Record<string, string | Set<string>> },
  {permission, onConfirm, onCancel}: { permission: AskQuestionPermission; onConfirm: (answers?: Record<string, string>) => void; onCancel: () => void },
  {handleOptionSelect, handleConfirmAction, handleCancel}: {
    handleOptionSelect: (key: string, label: string, multi: boolean) => void;
    handleConfirmAction: (selected: Record<string, string | Set<string>>, key: string, multi: boolean, onConfirm: (answers?: Record<string, string>) => void) => void;
    handleCancel: (onCancel: () => void) => void;
  },
): JSX.Element {
  const question = permission.questions?.[0];
  if (!question) return <></>;

  const multi = question?.multiSelect ?? false;
  const header = question.header ?? "请选择";
  const key = question.header ?? question.question;

  return (
    <div className="ask-question-card">
      <div className="ask-question-topline">
        <div className="ask-question-icon">?</div>
        <div className="ask-question-copy">
          <strong>需要确认</strong>
          <span className="ask-question-header">{header}</span>
        </div>
      </div>

      <div className="ask-question-text">{question.question}</div>

      <div className="ask-question-option-group">
        {question.options.map((opt, idx) => {
          const selectedClass = checkSelected(selected, key, multi, opt.label) ? " ask-question-option-selected" : "";
          return (
            <button
              key={idx}
              type="button"
              className={`ask-question-option${selectedClass}`}
              onClick={() => handleOptionSelect(key, opt.label, multi)}
            >
              <span className="ask-question-option-marker">
                {multi
                  ? (checkSelected(selected, key, multi, opt.label) ? "☑" : "□")
                  : (checkSelected(selected, key, multi, opt.label) ? "◉" : "○")}
              </span>
              <span className="ask-question-option-label">{opt.label}</span>
              {opt.description ? (
                <span className="ask-question-option-desc">{opt.description}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="ask-question-actions">
        <button type="button" className="ask-question-cancel-button" onClick={() => handleCancel(onCancel)}>
          取消
        </button>
        <button
          type="button"
          className="ask-question-confirm-button"
          onClick={() => handleConfirmAction(selected, key, multi, onConfirm)}
          disabled={isDisabled(selected, key, multi)}
        >
          确认
        </button>
      </div>
    </div>
  );
}

// ─── View component ───────────────────────────────────────────────────

export function AskQuestionCardView({permission, onConfirm, onCancel}: AskQuestionCardProps) {
  const question = permission.questions?.[0];
  const multi = question?.multiSelect ?? false;
  const key = question?.header ?? question?.question ?? "";

  const [selected, setSelected] = useState<Record<string, string | Set<string>>>(
    () => initSelected(question, multi, key),
  );

  // WriteState registrations
  WriteState.setSelected = setSelected;

  return render({
    state: {selected},
    props: {permission, onConfirm, onCancel},
    fn: renderAskQuestionCard,
    events: {handleOptionSelect, handleConfirmAction, handleCancel},
  });
}
