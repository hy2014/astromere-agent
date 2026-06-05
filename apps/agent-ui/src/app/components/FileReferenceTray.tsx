/* @checkFns file-reference-tray */
import type {StreamLink} from "../../types";
import type {LocalFileReference} from "../types";
import {localFileReferenceName, localReferenceToStreamLink} from "../file-utils";
import {render} from "../../core/dep";

interface FileReferenceTrayProps {
  fileReferences: LocalFileReference[];
  onOpenPreviewLink: (link: StreamLink) => void;
  onRemoveReference: (path: string) => void;
}

function renderFileReferenceTray(
  {}: Record<string, never>,
  {fileReferences}: { fileReferences: LocalFileReference[] },
  {onOpenPreviewLink, onRemoveReference}: { onOpenPreviewLink: (link: StreamLink) => void; onRemoveReference: (path: string) => void },
): JSX.Element {
  if (fileReferences.length === 0) return <></>;

  return (
    <div className="file-reference-tray" aria-label="Referenced files">
      {fileReferences.map((reference) => (
        <span className="file-reference-chip" key={reference.path}>
          <button
            className="file-reference-chip-preview"
            type="button"
            title={`在右侧预览 ${reference.path}`}
            onClick={() => onOpenPreviewLink(localReferenceToStreamLink(reference))}
          >
            <span className="file-reference-chip-icon" aria-hidden="true">@</span>
            <span className="file-reference-chip-text" title={reference.path}>
              {reference.name || localFileReferenceName(reference.path)}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Remove ${reference.path}`}
            onClick={() => onRemoveReference(reference.path)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function FileReferenceTrayView({
  fileReferences,
  onOpenPreviewLink,
  onRemoveReference,
}: FileReferenceTrayProps) {
  return render({
    state: {},
    props: {fileReferences, onOpenPreviewLink, onRemoveReference},
    fn: renderFileReferenceTray,
    events: {onOpenPreviewLink, onRemoveReference},
  });
}
