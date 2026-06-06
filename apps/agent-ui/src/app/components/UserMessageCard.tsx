import type {StreamItem, StreamLink} from "../../types";
import {RichMarkdownMessage} from "./preview-components";
import {MessageImagePreviews} from "./image-reference-view";
import {
  displayPromptText,
  localFileReferenceName,
  formatFileSize,
  localFileReferencesFromPromptText,
  localFileReferenceSummaryToStreamLink,
} from "../file-utils";

export interface UserMessageCardProps {
  item: Extract<StreamItem, { kind: "message" }>;
  projectRoot: string;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function UserMessageCard({
  item,
  projectRoot,
  onOpenPreviewLink,
}: UserMessageCardProps) {
  const messageDisplayText = displayPromptText(item.text);
  const userFileReferences =
    item.fileReferences?.length
      ? item.fileReferences
      : localFileReferencesFromPromptText(item.text);

  return (
    <article className="stream-message user">
      <div className="message-avatar" aria-hidden="true">
        person
      </div>
      <div className="message-body">
        <div className="stream-label-row">
          <div className="stream-label">User</div>
        </div>
        <div className="message-bubble">
          <RichMarkdownMessage content={messageDisplayText} />
          {userFileReferences.length > 0 ? (
            <div
              className="message-file-references"
              aria-label="Referenced files sent to Claude Code"
            >
              {userFileReferences.map((reference) => (
                <button
                  className={`message-file-reference-chip ${reference.failed ? "failed" : ""}`}
                  key={reference.path}
                  title={reference.path}
                  type="button"
                  onClick={() =>
                    void onOpenPreviewLink(
                      localFileReferenceSummaryToStreamLink(reference),
                    )
                  }
                  disabled={Boolean(reference.failed)}
                >
                  <span className="message-file-reference-icon" aria-hidden="true">
                    @
                  </span>
                  <span className="message-file-reference-name">
                    {reference.name || localFileReferenceName(reference.path)}
                  </span>
                  <span className="message-file-reference-meta">
                    {reference.failed
                      ? "读取失败"
                      : `${formatFileSize(reference.size_bytes)} · 注入 ${formatFileSize(reference.injected_bytes)}`}
                    {reference.truncated ? " · 已截断" : ""}
                  </span>
                  <span className="message-file-reference-open">右侧预览</span>
                </button>
              ))}
            </div>
          ) : null}
          <MessageImagePreviews
            root={projectRoot}
            links={item.links}
            onOpen={onOpenPreviewLink}
          />
          {item.links?.length ? (
            <div className="message-links local-reference-links">
              {item.links.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  onClick={() => onOpenPreviewLink(link)}
                >
                  <span>{link.kind}</span>
                  <strong>{link.label}</strong>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
