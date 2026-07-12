import {useState} from "react";
import type {Dag} from "../../types";
import {InlineTextPrompt} from "./InlineTextPrompt";

export type DagListPanelProps = {
  dags: Dag[];
  activeDagId: string | null;
  onSelectDag: (dagId: string) => void;
  onCreateDag: (name: string) => void;
  onUnpublishDag: (dagId: string) => void;
  onDeleteDag: (dagId: string) => void;
};

export function DagListPanel({
  dags,
  activeDagId,
  onSelectDag,
  onCreateDag,
  onUnpublishDag,
  onDeleteDag,
}: DagListPanelProps) {
  const [creating, setCreating] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);

  return (
    <div className="dag-list-section">
      <div className="dag-list">
        {creating ? (
          <InlineTextPrompt
            title="新建 DAG"
            label="名称"
            defaultValue="New DAG"
            confirmLabel="创建"
            onConfirm={(name) => {
              setCreating(false);
              onCreateDag(name);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : dags.length === 0 ? (
          <p className="dag-list-empty">还没有 DAG，点击下方「新建 DAG」开始。</p>
        ) : (
          dags.map((dag) => (
            <div
              key={dag.id}
              className={`dag-list-item ${dag.id === activeDagId ? "active" : ""}`}
              onClick={() => {
                setMenuId(null);
                onSelectDag(dag.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuId(dag.id);
              }}
            >
              <span className="dag-list-name">{dag.name}</span>
              <span className={`dag-list-status dag-list-status--${dag.status}`}>{dag.status}</span>
              {dag.cron && <span className="dag-list-cron" title="Cron schedule">{dag.cron}</span>}
              <button
                type="button"
                className="dag-kebab"
                title="操作"
                aria-label="DAG actions"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuId(menuId === dag.id ? null : dag.id);
                }}
              >
                ⋯
              </button>
              {menuId === dag.id && (
                <>
                  <div
                    className="dag-menu-backdrop"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuId(null);
                    }}
                  />
                  <div className="dag-menu" onClick={(event) => event.stopPropagation()}>
                    {dag.status === "published" && (
                      <button
                        type="button"
                        className="dag-menu-unpublish"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuId(null);
                          onUnpublishDag(dag.id);
                        }}
                      >
                        下线
                      </button>
                    )}
                    <button
                      type="button"
                      className={`dag-menu-delete ${dag.status === "published" ? "dag-menu-delete--disabled" : ""}`}
                      title={dag.status === "published" ? "请先下线后再删除" : undefined}
                      disabled={dag.status === "published"}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (dag.status === "published") return;
                        setMenuId(null);
                        onDeleteDag(dag.id);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
      {!creating && (
        <button type="button" className="fn-add-btn" onClick={() => setCreating(true)}>
          + 新建 DAG
        </button>
      )}
    </div>
  );
}
