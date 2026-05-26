import { useState, useEffect } from "react"
import { listWorktrees } from "../runtime"
import type { WorktreeItem } from "../types"

type Props = {
  root: string
  onCreate: (info: { name: string; sessionId: string }) => Promise<void>
  onRemove: (path: string) => Promise<void>
  activeSessionId?: string | null
  projectId?: string
  projectName?: string
  setActiveView?: (view: any) => void
  setActiveProjectId?: (id: string) => void
  setActiveSessionId?: (id: string) => void
  setSessionStreams?: (updater: (streams: any) => any) => void
  onForkWorktreeSession?: (session: any) => void
  onHideWorktreeSession?: (session: any) => void
}

const BRANCH_PREFIXES = [
  { label: "feature/", value: "feature/" },
  { label: "bugfix/", value: "bugfix/" },
  { label: "hotfix/", value: "hotfix/" },
  { label: "custom", value: "" },
]

export function WorktreePanel({ root, onCreate, onRemove, activeSessionId, projectId, projectName, setActiveView, setActiveProjectId, setActiveSessionId, setSessionStreams, onForkWorktreeSession, onHideWorktreeSession }: Props) {
  const [worktrees, setWorktrees] = useState<WorktreeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [prefix, setPrefix] = useState("feature/")
  const [branchName, setBranchName] = useState("")
  const [creating, setCreating] = useState(false)
  const [openSessionMenu, setOpenSessionMenu] = useState<{ root: string; sessionId: string } | null>(null)

  const loadWorktrees = async () => {
    try {
      setLoading(true)
      // const { listWorktrees } = await import("../runtime")
      const items = await listWorktrees(root)
      const filtered = items.filter((wt: WorktreeItem) => wt.path.includes(".claude/worktrees"))
      setWorktrees(filtered)
    } catch {
      setWorktrees([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadWorktrees()
  }, [root])

  const handleCreate = async () => {
    const name = prefix + branchName.trim()
    if (!branchName.trim()) return
    try {
      setCreating(true)
      setError(null)
      const sessionId = crypto.randomUUID()
      await onCreate({ name, sessionId })
      setShowModal(false)
      setBranchName("")
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setCreating(false)
    }
  }

  const handleRemove = async (path: string) => {
    try {
      setError(null)
      await onRemove(path)
      await loadWorktrees()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }

  const handleSelectWorktreeSession = (sessionId: string) => {
    if (setActiveView) setActiveView("workspace")
    if (setActiveProjectId && projectId) setActiveProjectId(projectId)
    if (setActiveSessionId) setActiveSessionId(sessionId)
    if (setSessionStreams) {
      setSessionStreams((streams: any) => ({
        ...streams,
        [sessionId]: streams[sessionId] ?? [],
      }))
    }
  }

  const closeModal = () => {
    setShowModal(false)
    setBranchName("")
    setPrefix("feature/")
    setError(null)
  }

  return (
    <div className="worktree-panel">
      {(loading) && (
        <div className="worktree-loading">Loading...</div>
      )}

      {(error && !showModal) && (
        <div className="worktree-error">{error}</div>
      )}



      <button
        className="worktree-create-btn"
        onClick={() => setShowModal(true)}
      >
        + New Worktree
      </button>

      {(!loading && worktrees.length > 0) && (
        <div className="worktree-session-list">
          {worktrees.flatMap((wt) =>
            wt.sessions.map((s) => {
              const isActive = activeSessionId === s.id
              const isMenuOpen =
                openSessionMenu?.root === root &&
                openSessionMenu?.sessionId === s.id
              return (
                <div
                  key={s.id}
                  className={`tree-session-row ${isActive ? "active" : ""}`}
                >
                  <button
                    className="tree-session-main"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSelectWorktreeSession(s.id)
                    }}
                  >
                    <span
                      className="session-status-dot active"
                      title="running"
                    />
                    <span className="tree-label" title={s.title}>
                      {s.title}
                    </span>
                  </button>
                  <button
                    className="session-menu-button"
                    type="button"
                    aria-label={`Open menu for ${s.title}`}
                    aria-expanded={isMenuOpen}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenSessionMenu((current) =>
                        current?.root === root &&
                        current?.sessionId === s.id
                          ? null
                          : { root, sessionId: s.id }
                      )
                    }}
                  >
                    ...
                  </button>
                  {isMenuOpen && (
                    <div className="session-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation()
                          onForkWorktreeSession?.(s)
                        }}
                      >
                        Fork
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation()
                          onHideWorktreeSession?.(s)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {(showModal) && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content worktree-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>New Worktree</h3>
            </div>
            <div className="modal-body">
              <p className="modal-desc">
                Create an isolated worktree based on the current branch.
                A new Claude session will start in the worktree.
              </p>
              <div className="worktree-create-row">
                <select
                  className="worktree-prefix-select"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                >
                  {BRANCH_PREFIXES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <input
                  className="worktree-name-input"
                  type="text"
                  placeholder="branch-name"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate() }}
                  autoFocus
                />
              </div>
              <div className="worktree-prompt-actions">
                <div className="worktree-prompt-buttons">
                  <button className="worktree-btn-cancel" onClick={closeModal}>Cancel</button>
                  <button
                    className="worktree-btn-send"
                    onClick={handleCreate}
                    disabled={creating}
                  >
                    {creating ? "CREATING..." : "CREATE"}
                  </button>
                </div>
              </div>
              { (error) && (<div className="worktree-error" style={{marginTop: 8}}>{error}</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
