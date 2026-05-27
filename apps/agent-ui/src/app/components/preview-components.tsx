import {useMemo, useState} from "react";
import type {FileView} from "../../types";
import type {RichMarkdownBlock} from "../types";
import {lineNumberPreview} from "../file-utils";
import {formatFileSize} from "../stream-processor";

// ─── CSV helpers ───────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function parseCsvPreview(content: string, maxRows = 120, maxColumns = 28): {
  header: string[];
  rows: string[][];
  totalRowsInContent: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
} {
  const allLines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const parsedRows = allLines.map(parseCsvLine);
  const widest = parsedRows.reduce((max, row) => Math.max(max, row.length), 0);
  const truncatedColumns = widest > maxColumns;
  const width = Math.min(widest, maxColumns);
  const headerSource = parsedRows[0] ?? [];
  const header = Array.from({ length: width }, (_, index) => {
    const value = headerSource[index]?.trim();
    return value || `Column ${index + 1}`;
  });
  const bodySource = parsedRows.slice(1, maxRows + 1);
  const rows = bodySource.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
  return {
    header,
    rows,
    totalRowsInContent: Math.max(0, parsedRows.length - 1),
    truncatedRows: parsedRows.length - 1 > maxRows,
    truncatedColumns,
  };
}

export function isHtmlFilePath(path: string, language?: string) {
  const lowerPath = path.toLowerCase();
  const lowerLanguage = language?.toLowerCase() ?? "";
  return (
    lowerLanguage === "html" ||
    lowerLanguage === "htm" ||
    lowerPath.endsWith(".html") ||
    lowerPath.endsWith(".htm")
  );
}

// ─── CsvDataPreview ────────────────────────────────────────────────────

export function CsvDataPreview({ file }: { file: FileView }) {
  const preview = useMemo(() => parseCsvPreview(file.content), [file.content]);
  const [copied, setCopied] = useState(false);

  async function handleCopyPath() {
    await navigator.clipboard?.writeText(file.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="csv-data-preview">
      <div className="csv-data-toolbar">
        <div>
          <strong>CSV 数据预览</strong>
          <span>
            {formatFileSize(file.size_bytes)} · {file.total_lines} lines · 预览 {preview.rows.length} / {preview.totalRowsInContent} rows
            {preview.truncatedColumns ? " · 列已截断" : ""}
          </span>
        </div>
        <button type="button" onClick={() => void handleCopyPath()}>
          {copied ? "已复制路径" : "复制路径"}
        </button>
      </div>
      {(preview.truncatedRows || preview.truncatedColumns) ? (
        <div className="csv-data-notice">
          为避免卡顿，右侧面板只预览前 120 行、前 28 列。完整内容仍按引用规则发送给 Claude Code，超出注入上限时会截断。
        </div>
      ) : null}
      <div className="csv-data-table-wrap">
        <table className="csv-data-table">
          <thead>
            <tr>
              {preview.header.map((column, index) => (
                <th key={`${column}-${index}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={`${rowIndex}-${columnIndex}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── HtmlRichPreview ───────────────────────────────────────────────────

export function HtmlRichPreview({
  content,
  title,
}: {
  content: string;
  title?: string;
}) {
  return (
    <div className="html-rich-preview">
      <iframe
        title={title ?? "HTML preview"}
        sandbox="allow-scripts"
        srcDoc={content}
      />
    </div>
  );
}

// ─── CodePreview ───────────────────────────────────────────────────────

export function CodePreview({ content }: { content: string }) {
  return (
    <div className="code-preview">
      <div className="line-gutter" aria-hidden="true">
        {lineNumberPreview(content).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      <pre>{content}</pre>
    </div>
  );
}

// ─── Markdown helpers ──────────────────────────────────────────────────

function parseMarkdownTable(lines: string[], startIndex: number): {
  block?: RichMarkdownBlock;
  nextIndex: number;
} {
  const separator = lines[startIndex + 1];
  if (!lines[startIndex]?.trim().startsWith("|") || !separator?.trim().startsWith("|")) {
    return { nextIndex: startIndex };
  }

  const separatorCells = separator
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  if (!separatorCells.length || !separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return { nextIndex: startIndex };
  }

  const rows: string[][] = [];
  let index = startIndex;
  while (index < lines.length && lines[index].trim().startsWith("|")) {
    const line = lines[index].trim();
    rows.push(
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
    index += 1;
  }

  const [header, , ...bodyRows] = rows;
  if (!header || bodyRows.length === 0) {
    return { nextIndex: startIndex };
  }

  return {
    block: { kind: "table", headers: header, rows: bodyRows },
    nextIndex: index,
  };
}

function splitRichMarkdown(content: string): RichMarkdownBlock[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: RichMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```\s*([\w.+-]*)\s*$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || "text";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ kind: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table.block) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const ordered = /^\d+[.)]\s+/.test(trimmed);
      const items: string[] = [];
      const itemPattern = ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/;
      while (index < lines.length && itemPattern.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(itemPattern, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (
        !next ||
        next.startsWith("```") ||
        next.startsWith("|") ||
        /^#{1,3}\s+/.test(next) ||
        /^>\s?/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderRichInline(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const key = `${keyPrefix}:${index}`;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="rich-inline-code" key={key}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}

function isFileAccessNotice(content: string): boolean {
  return (
    /无法直接读取|outside|之外|cannot directly read|permission|权限/i.test(content) &&
    /文件|path|workspace|工作目录|cwd|目录/i.test(content)
  );
}

// ─── RichMarkdownMessage ───────────────────────────────────────────────

export function RichMarkdownMessage({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const blocks = splitRichMarkdown(content);
  const className = `rich-markdown-message${compact ? " compact" : ""}${
    isFileAccessNotice(content) ? " file-access-notice" : ""
  }`;

  return (
    <div className={className}>
      {isFileAccessNotice(content) ? (
        <div className="rich-notice-banner">
          <span aria-hidden="true">!</span>
          <strong>文件访问提示</strong>
        </div>
      ) : null}
      {blocks.map((block, index) => {
        const key = `rich:${index}`;
        if (block.kind === "heading") {
          const Heading = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          return <Heading key={key}>{renderRichInline(block.text, key)}</Heading>;
        }
        if (block.kind === "paragraph") {
          return <p key={key}>{renderRichInline(block.text, key)}</p>;
        }
        if (block.kind === "quote") {
          return <blockquote key={key}>{renderRichInline(block.text, key)}</blockquote>;
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag className="rich-list" key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}:${itemIndex}`}>{renderRichInline(item, `${key}:${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.kind === "code") {
          return (
            <div className="rich-code-block" key={key}>
              <div className="rich-code-header">
                <span>{block.language || "text"}</span>
                <button
                  type="button"
                  className="rich-code-copy-button"
                  onClick={(event) => {
                    const btn = event.currentTarget;
                    const text = block.code;
                    const doCopy = navigator.clipboard?.writeText(text)
                      ?? new Promise((resolve, reject) => {
                        const ta = document.createElement("textarea");
                        ta.value = text;
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand("copy"); resolve(); }
                        catch { reject(); }
                        document.body.removeChild(ta);
                      });
                    doCopy.then(() => {
                      btn.textContent = "已复制";
                      setTimeout(() => { btn.textContent = "复制"; }, 1600);
                    }).catch(() => {
                      btn.textContent = "失败";
                      setTimeout(() => { btn.textContent = "复制"; }, 1600);
                    });
                  }}
                >
                  复制
                </button>
              </div>
              <pre>{block.code}</pre>
            </div>
          );
        }
        if (block.kind === "table") {
          return (
            <div className="rich-table-wrap" key={key}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((cell, cellIndex) => (
                      <th key={`${key}:h:${cellIndex}`}>{renderRichInline(cell, `${key}:h:${cellIndex}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}:r:${rowIndex}`}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={`${key}:r:${rowIndex}:${cellIndex}`}>
                          {renderRichInline(row[cellIndex] ?? "", `${key}:r:${rowIndex}:${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── MarkdownPreview ───────────────────────────────────────────────────

export function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="markdown-preview">
      {lines.map((line, index) => {
        if (line.startsWith("### ")) {
          return <h3 key={index}>{line.slice(4)}</h3>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={index}>{line.slice(3)}</h2>;
        }
        if (line.startsWith("# ")) {
          return <h1 key={index}>{line.slice(2)}</h1>;
        }
        if (line.startsWith("- ")) {
          return (
            <p className="markdown-list" key={index}>
              {line}
            </p>
          );
        }
        if (!line.trim()) {
          return <div className="markdown-space" key={index} />;
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

// ─── MarkdownTablePreview ──────────────────────────────────────────────

export function MarkdownTablePreview({ content }: { content: string }) {
  const rows = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.some((cell) => cell.length > 0));

  if (rows.length < 2) {
    return <p>{content}</p>;
  }

  const [header, ...rest] = rows.filter(
    (cells) =>
      !cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, ""))),
  );

  return (
    <div className="table-preview">
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={`${cell}-${index}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rest.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
