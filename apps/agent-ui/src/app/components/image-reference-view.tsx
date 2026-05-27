import {useEffect, useState} from "react";
import type {LocalImagePreview, StreamLink} from "../../types";
import type {LocalImageMetadata} from "../types";
import {readLocalImageMetadata, readLocalImagePreview,} from "../../runtime";
import {formatPreviewBytes} from "../file-utils";
import {INLINE_IMAGE_PREVIEW_BYTES} from "../constants";

// ─── MessageImagePreviews ──────────────────────────────────────────────

export function MessageImagePreviews({
  root,
  links,
  onOpen,
}: {
  root: string;
  links?: StreamLink[];
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const imageLinks = (links ?? []).filter((link) => link.kind === "image");
  if (imageLinks.length === 0) {
    return null;
  }

  return (
    <div className="message-image-preview-grid">
      {imageLinks.map((link) => (
        <MessageImagePreviewItem key={link.id} root={root} link={link} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ─── MessageImagePreviewItem ───────────────────────────────────────────

export function MessageImagePreviewItem({
  root,
  link,
  onOpen,
}: {
  root: string;
  link: StreamLink;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const [metadata, setMetadata] = useState<LocalImageMetadata | null>(null);
  const [preview, setPreview] = useState<LocalImagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetadata(null);
    setPreview(null);
    setError(null);

    if (!root) {
      setError("没有可用的 workspace root，无法读取本地图片。");
      return () => {
        cancelled = true;
      };
    }

    readLocalImageMetadata(root, link.path)
      .then(async (nextMetadata) => {
        if (cancelled) {
          return;
        }
        setMetadata(nextMetadata);

        if (nextMetadata.sizeBytes <= INLINE_IMAGE_PREVIEW_BYTES) {
          const nextPreview = await readLocalImagePreview(root, link.path);
          if (!cancelled) {
            setPreview(nextPreview);
          }
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [root, link.path]);

  if (preview) {
    return <InlineImagePreview link={link} preview={preview} onOpen={onOpen} />;
  }

  return <ImageArtifactCard link={link} metadata={metadata} error={error} onOpen={onOpen} />;
}

// ─── InlineImagePreview ────────────────────────────────────────────────

export function InlineImagePreview({
  link,
  preview,
  onOpen,
}: {
  link: StreamLink;
  preview: LocalImagePreview;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  return (
    <button
      className="message-inline-image-preview"
      type="button"
      onClick={() => void onOpen(link)}
      title="点击在右侧查看大图"
    >
      <img alt={link.label} src={preview.dataUrl} />
      <span className="message-inline-image-meta">
        <strong>{link.label}</strong>
        <small>{formatPreviewBytes(preview.sizeBytes)} · 点击右侧预览</small>
      </span>
    </button>
  );
}

// ─── ImageArtifactCard ─────────────────────────────────────────────────

export function ImageArtifactCard({
  link,
  metadata,
  error,
  onOpen,
}: {
  link: StreamLink;
  metadata?: LocalImageMetadata | null;
  error?: string | null;
  onOpen: (link: StreamLink) => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopyPath(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    await navigator.clipboard?.writeText(link.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  const metadataSizeBytes = typeof metadata?.sizeBytes === "number"
    ? metadata.sizeBytes
    : typeof metadata?.size_bytes === "number"
      ? metadata.size_bytes
      : undefined;
  const sizeLabel = typeof metadataSizeBytes === "number" ? formatPreviewBytes(metadataSizeBytes) : error ? "预览信息读取失败" : "读取中…";
  const isLarge = typeof metadataSizeBytes === "number" ? metadataSizeBytes > INLINE_IMAGE_PREVIEW_BYTES : false;

  return (
    <div className="message-image-artifact-card">
      <button
        className="message-image-artifact-main"
        type="button"
        onClick={() => void onOpen(link)}
        title="点击在右侧预览图片"
      >
        <span className="image-artifact-icon" aria-hidden="true">▧</span>
        <span className="image-artifact-copy">
          <strong>{link.label}</strong>
          <small>{sizeLabel}{isLarge ? " · 大图右侧预览" : ""}</small>
          <small>{link.path}</small>
        </span>
        <span className="image-artifact-open">右侧预览</span>
      </button>
      <button
        className="image-artifact-copy-button"
        type="button"
        onClick={(event) => void handleCopyPath(event)}
      >
        {copied ? "已复制" : "复制路径"}
      </button>
    </div>
  );
}

// ─── ReferencePanel ────────────────────────────────────────────────────

export function ReferencePanel({ link, root }: { link: StreamLink; root: string }) {
  if (link.kind === "image") {
    return <ImageReferencePanel link={link} root={root} />;
  }

  const label = link.kind === "pdf" ? "PDF Preview(todo)" : "Preview(todo)";
  return (
    <section className="reference-workbench">
      <div className="detail-header">
        <div>
          <div className="eyebrow">{link.kind}</div>
          <h2>{link.label}</h2>
        </div>
        <span className="count-label">preview</span>
      </div>

      <div className="reference-card">
        <strong>{link.path}</strong>
        <p>{label}</p>
      </div>
    </section>
  );
}

// ─── ImageReferencePanel ───────────────────────────────────────────────

export function ImageReferencePanel({ link, root }: { link: StreamLink; root: string }) {
  const [preview, setPreview] = useState<LocalImagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);

    if (!root) {
      setError("没有可用的 workspace root，无法读取本地图片。");
      return () => {
        cancelled = true;
      };
    }

    readLocalImagePreview(root, link.path)
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [root, link.path]);

  async function handleCopyPath() {
    await navigator.clipboard?.writeText(preview?.path ?? link.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <section className="reference-workbench image-reference-workbench">
      <div className="detail-header image-reference-header">
        <div>
          <div className="eyebrow">Image Artifact</div>
          <h2>{link.label}</h2>
        </div>
        <div className="image-reference-actions">
          {preview ? (
            <span className="count-label">
              {preview.mimeType} · {formatPreviewBytes(preview.sizeBytes)}
            </span>
          ) : null}
          <button type="button" onClick={() => void handleCopyPath()}>
            {copied ? "已复制" : "复制路径"}
          </button>
        </div>
      </div>

      <div className="image-reference-path" title={preview?.path ?? link.path}>
        {preview?.path ?? link.path}
      </div>

      <div className="image-reference-stage">
        {preview ? (
          <img alt={link.label} src={preview.dataUrl} />
        ) : error ? (
          <div className="image-reference-placeholder failed">
            <strong>图片预览失败</strong>
            <p>{error}</p>
          </div>
        ) : (
          <div className="image-reference-placeholder">
            <strong>正在加载图片…</strong>
            <p>大图不会塞进聊天流，会在右侧预览面板渲染。</p>
          </div>
        )}
      </div>
    </section>
  );
}
