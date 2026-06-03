import {useState} from "react";

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

export function AskQuestionCard({permission, onConfirm, onCancel}: AskQuestionCardProps) {
  const question = permission.questions?.[0];
  const multi = question?.multiSelect ?? false;

  // selected[header] = label   (single)
  // selected[header] = Set<label>  (multi)
  const [selected, setSelected] = useState<Record<string, string | Set<string>>>(
    () => {
      if (!question) return {};
      if (multi) return {[question.header ?? question.question]: new Set<string>()};
      return {};
    },
  );

  if (!question) {
    return null;
  }

  const header = question.header ?? "请选择";
  const key = question.header ?? question.question;

  const toggleSingle = (label: string) => {
    setSelected({[key]: label});
  };

  const toggleMulti = (label: string) => {
    setSelected((prev) => {
      const set = new Set(prev[key] instanceof Set ? (prev[key] as Set<string>) : undefined);
      if (set.has(label)) {
        set.delete(label);
      } else {
        set.add(label);
      }
      return {...prev, [key]: set};
    });
  };

  const handleConfirm = () => {
    const entry = selected[key];
    if (multi && entry instanceof Set) {
      const labels = [...entry];
      if (labels.length === 0) return;
      onConfirm({[key]: labels.join(", ")});
    } else if (typeof entry === "string") {
      onConfirm({[key]: entry});
    }
  };

  const isSelected = (label: string) => {
    const entry = selected[key];
    if (multi && entry instanceof Set) return entry.has(label);
    return entry === label;
  };

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
          const selectedClass = isSelected(opt.label) ? " ask-question-option-selected" : "";
          return (
            <button
              key={idx}
              type="button"
              className={`ask-question-option${selectedClass}`}
              onClick={() => (multi ? toggleMulti(opt.label) : toggleSingle(opt.label))}
            >
              <span className="ask-question-option-marker">
                {multi
                  ? (isSelected(opt.label) ? "☑" : "□")
                  : (isSelected(opt.label) ? "◉" : "○")}
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
        <button type="button" className="ask-question-cancel-button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="ask-question-confirm-button"
          onClick={handleConfirm}
          disabled={
            multi
              ? !(selected[key] instanceof Set && (selected[key] as Set<string>).size > 0)
              : !selected[key]
          }
        >
          确认
        </button>
      </div>
    </div>
  );
}
