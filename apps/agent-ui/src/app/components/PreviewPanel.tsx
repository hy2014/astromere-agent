import type {StreamLink} from "../../types";
import type {PreviewTab, ProjectFolder} from "../types";
import {CodePreviewView, CsvDataPreview, HtmlRichPreview, isHtmlFilePath, MarkdownPreview} from "./preview-components";
import {ReferencePanel} from "./image-reference-view";
import {isCsvFilePath, isMarkdownFile} from "../file-utils";

interface PreviewPanelProps {
  activePreview: PreviewTab;
  previewTabs: PreviewTab[];
  activeProject: ProjectFolder | null;
  onSetActivePreviewId: (id: string | null) => void;
  onClosePreviewTab: (id: string) => void;
  onCloseAllPreviews: () => void;
  onOpenPreviewLink: (link: StreamLink) => void;
}

export function PreviewPanelView({
  activePreview,
  previewTabs,
  activeProject,
  onSetActivePreviewId,
  onClosePreviewTab,
  onCloseAllPreviews,
  onOpenPreviewLink,
}: PreviewPanelProps) {
  return (
    <>
      <header className="preview-tabs">
        <div className="preview-tab-strip">
          {previewTabs.map((tab) => (
            <div
              key={tab.id}
              className={`preview-tab ${tab.id === activePreview.id ? "active" : ""}`}
            >
              <button
                className="preview-tab-label"
                type="button"
                onClick={() => onSetActivePreviewId(tab.id)}
              >
                <span>{tab.kind}</span>
                <strong>{tab.title}</strong>
              </button>
              <button
                className="tab-close"
                type="button"
                onClick={() => onClosePreviewTab(tab.id)}
                aria-label={`Close ${tab.title}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="preview-actions">
          <button type="button" title="Fullscreen">
            □
          </button>
          <button
            type="button"
            title="Close preview"
            onClick={onCloseAllPreviews}
          >
            ×
          </button>
        </div>
      </header>

      {activePreview.kind === "file" ? (
        <section className="file-workbench">
          <div className="detail-header">
            <div>
              <div className="eyebrow">Open File</div>
              <h2>{activePreview.file.path}</h2>
            </div>
            <span className="count-label">read-only</span>
          </div>
          <div className="file-view">
            <div className="file-meta">
              <span>{activePreview.file.path}</span>
              <span>
                {activePreview.file.total_lines} lines ·{" "}
                {activePreview.file.size_bytes} bytes ·{" "}
                {activePreview.file.language}
              </span>
            </div>
            {isCsvFilePath(activePreview.file.path, activePreview.file.language) ? (
              <CsvDataPreview file={activePreview.file} />
            ) : isHtmlFilePath(activePreview.file.path, activePreview.file.language) ? (
              <HtmlRichPreview
                content={activePreview.file.content}
                title={activePreview.file.path}
              />
            ) : isMarkdownFile(activePreview.file.path) ? (
              <MarkdownPreview content={activePreview.file.content} />
            ) : (
              <CodePreviewView content={activePreview.file.content} />
            )}
          </div>
          <div className="section-heading diff-heading">
            <span>Git Diff</span>
            <span className="count-label">
              {activePreview.diff?.is_empty ? "empty" : "changed"}
            </span>
          </div>
          <pre className="diff-view">
            {activePreview.diff?.diff || "No diff loaded."}
          </pre>
        </section>
      ) : (
        <ReferencePanel link={activePreview.link} root={activeProject?.root ?? ""} />
      )}
    </>
  );
}
