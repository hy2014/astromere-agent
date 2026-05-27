import {useEffect, useMemo, useState} from "react";
import {listSkills} from "../../runtime";
import type {SkillsReport, SkillSummary} from "../../types";
import type {SkillsViewProps, SkillViewMode} from "../types";
import {formatFileSize} from "../stream-processor";

// ─── Pure helpers ──────────────────────────────────────────────────────

function skillDateLabel(timestamp?: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function skillCapabilityLabel(skill: SkillSummary): string[] {
  if (skill.capabilities && skill.capabilities.length > 0) {
    return skill.capabilities;
  }
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    return skill.allowedTools.slice(0, 4);
  }
  return ["Prompt Skill"];
}

function skillIdentity(skill: SkillSummary): string {
  return skill.id ?? `${skill.source?.kind ?? skill.origin?.id ?? "unknown"}:${skill.name}`;
}

// ─── SkillsView component ──────────────────────────────────────────────

export function SkillsView({ activeProject }: SkillsViewProps) {
  const [report, setReport] = useState<SkillsReport | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<SkillViewMode>("grid");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading installed skills...");

  useEffect(() => {
    if (!activeProject) {
      setReport(null);
      setSelectedSkillId(null);
      setStatus("Add or select a project to inspect project and user skills.");
      return;
    }

    let cancelled = false;
    setStatus("Loading installed skills...");
    listSkills(activeProject.root)
      .then((nextReport) => {
        if (cancelled) {
          return;
        }
        setReport(nextReport);
        setSelectedSkillId((current) => {
          if (current && nextReport.skills.some((skill) => skillIdentity(skill) === current)) {
            return current;
          }
          return nextReport.skills[0] ? skillIdentity(nextReport.skills[0]) : null;
        });
        setStatus(
          nextReport.skills.length > 0
            ? "Installed skills loaded."
            : "No installed project or user skills found.",
        );
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setReport(null);
        setSelectedSkillId(null);
        setStatus(`Failed to load skills: ${String(reason)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProject?.root]);

  const skills = report?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return skills;
    }
    return skills.filter((skill) => {
      const searchable = [
        skill.name,
        skill.description,
        skill.whenToUse,
        skill.version,
        skill.context,
        skill.agent,
        skill.model,
        ...(skill.allowedTools ?? []),
        ...(skill.capabilities ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalized);
    });
  }, [skills, query]);

  const selectedSkill =
    filteredSkills.find((skill) => skillIdentity(skill) === selectedSkillId) ??
    filteredSkills[0] ??
    skills.find((skill) => skillIdentity(skill) === selectedSkillId) ??
    null;

  const total = report?.summary?.total ?? skills.length;
  const active = report?.summary?.active ?? skills.filter((skill) => skill.enabled !== false).length;
  const shadowed = report?.summary?.shadowed ?? 0;
  const sources = report?.sources ?? [];

  return (
    <section className="skills-installed-view" aria-label="Installed skills">
      <div className="skills-admin-topbar">
        <strong>Enterprise Control</strong>
        <nav aria-label="Skills breadcrumb">
          <span>Skills</span>
          <span>›</span>
          <b>Installed</b>
        </nav>
        <div className="skills-admin-icons" aria-hidden="true">
          <span>⌁</span>
          <span>?</span>
          <span>◎</span>
        </div>
      </div>
      <header className="skills-installed-hero">
        <div>
          <div className="skills-breadcrumb">Skills / Installed</div>
          <h1>Installed Skills</h1>
          <p>
            Manage skills discovered from the active workspace and <code>~/.claude/skills</code>. This view uses the
            local Tauri API and does not require a remote hub.
          </p>
        </div>
        <div className="skills-hero-actions">
          <button type="button" disabled>
            Import Skill
          </button>
          <button type="button" className="primary" disabled>
            New Skill
          </button>
        </div>
      </header>

      <div className="skills-stat-row" aria-label="Skill summary">
        <article>
          <span>Total</span>
          <strong>{total}</strong>
        </article>
        <article>
          <span>Active</span>
          <strong>{active}</strong>
        </article>
        <article>
          <span>Shadowed</span>
          <strong>{shadowed}</strong>
        </article>
      </div>

      {sources.length > 0 ? (
        <div className="skills-sources-row" aria-label="Skill scan paths">
          {sources.map((source) => (
            <article key={source.kind} className={source.exists ? "" : "missing"}>
              <span>{source.label}</span>
              <code>{source.path}</code>
              <small>{source.exists ? `${source.count} skills` : "directory missing"}</small>
            </article>
          ))}
        </div>
      ) : null}

      <div className="skills-toolbar">
        <label className="skills-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search installed skills..."
          />
        </label>
        <div className="skills-view-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
          >
            List
          </button>
        </div>
      </div>

      <div className="skills-installed-layout">
        <section
          className={`skills-card-list ${viewMode === "list" ? "list" : "grid"}`}
          aria-label="Skill list"
        >
          {filteredSkills.map((skill) => {
            const capabilities = skillCapabilityLabel(skill);
            const id = skillIdentity(skill);
            const isSelected = selectedSkill ? skillIdentity(selectedSkill) === id : false;
            return (
              <button
                key={id}
                type="button"
                className={`skill-card ${isSelected ? "selected" : ""}`}
                onClick={() => setSelectedSkillId(id)}
              >
                <span className="skill-card-topline">
                  <span className="skill-card-icon" aria-hidden="true">
                    ✦
                  </span>
                  <span className="skill-card-source">
                    {skill.source?.label ?? skill.origin?.label ?? "Project"}
                  </span>
                </span>
                <strong>{skill.name}</strong>
                <p>{skill.description || "No description in SKILL.md frontmatter."}</p>
                <span className="skill-card-tags">
                  {capabilities.slice(0, 3).map((capability) => (
                    <small key={capability}>{capability}</small>
                  ))}
                </span>
                <span className="skill-card-meta">
                  <span>{skill.version ? `v${skill.version}` : "No version"}</span>
                  <span>{formatFileSize(skill.sizeBytes)}</span>
                </span>
                {skill.enabled === false ? <span className="skill-card-warning">Shadowed</span> : null}
              </button>
            );
          })}
          {filteredSkills.length === 0 ? (
            <div className="skills-empty-state">
              <strong>No skills found</strong>
              <p>{status}</p>
            </div>
          ) : null}
        </section>

        <aside className="skill-detail-panel" aria-label="Skill detail">
          {selectedSkill ? (
            <>
              <div className="skill-detail-header">
                <div className="skill-detail-icon" aria-hidden="true">
                  ✦
                </div>
                <div>
                  <div className="skills-breadcrumb">Skill Detail</div>
                  <h2>{selectedSkill.name}</h2>
                  <p>{selectedSkill.description || "No description provided."}</p>
                </div>
              </div>

              <div className="skill-detail-actions">
                <button type="button" disabled>
                  Settings
                </button>
                <button type="button" disabled>
                  Uninstall
                </button>
              </div>

              <section className="skill-detail-section">
                <h3>Capabilities</h3>
                <div className="skill-chip-list">
                  {skillCapabilityLabel(selectedSkill).map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              </section>

              <section className="skill-detail-section">
                <h3>Metadata</h3>
                <dl className="skill-meta-grid">
                  <div>
                    <dt>Version</dt>
                    <dd>{selectedSkill.version || "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Installed</dt>
                    <dd>{skillDateLabel(selectedSkill.installedAtMs)}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatFileSize(selectedSkill.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>{selectedSkill.context || "inline"}</dd>
                  </div>
                  <div>
                    <dt>Agent</dt>
                    <dd>{selectedSkill.agent || "Default"}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedSkill.model || "Default"}</dd>
                  </div>
                </dl>
              </section>

              <section className="skill-detail-section">
                <h3>When to use</h3>
                <p>{selectedSkill.whenToUse || "No when_to_use guidance found."}</p>
              </section>

              <section className="skill-detail-section">
                <h3>Allowed tools</h3>
                {selectedSkill.allowedTools && selectedSkill.allowedTools.length > 0 ? (
                  <div className="skill-tool-list">
                    {selectedSkill.allowedTools.map((tool) => (
                      <code key={tool}>{tool}</code>
                    ))}
                  </div>
                ) : (
                  <p>No allowed-tools declared.</p>
                )}
              </section>

              <section className="skill-detail-section">
                <h3>Local path</h3>
                <code className="skill-path-code">{selectedSkill.path || selectedSkill.skillRoot || "Unknown"}</code>
              </section>

              {selectedSkill.validation && selectedSkill.validation.length > 0 ? (
                <section className="skill-detail-section warning">
                  <h3>Validation</h3>
                  <ul>
                    {selectedSkill.validation.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : (
            <div className="skills-empty-state detail">
              <strong>No skill selected</strong>
              <p>{status}</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
