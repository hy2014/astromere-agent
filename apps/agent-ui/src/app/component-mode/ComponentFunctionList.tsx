import {useState} from "react";
import type {Component, Dag} from "../../types";
import {DagListPanel} from "./DagListPanel";
import {COMPONENT_DRAG_KEY, GENERIC_DRAG_KEY} from "./componentModel";

export type ComponentFunctionListProps = {
  components: Component[];
  dags: Dag[];
  activeDagId: string | null;
  onSelectDag: (id: string) => void;
  onCreateDag: (name: string) => void;
  onUnpublishDag: (id: string) => void;
  onDeleteDag: (id: string) => void;
  onStartRegister: () => void;
  onEditComponent: (component: Component) => void;
  onViewComponent: (component: Component) => void;
  onDeleteComponent: (component: Component) => void;
  onOpenServerSettings: () => void;
};

type OpenState = {component: boolean; dag: boolean; advanced: boolean};

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`fn-section${open ? " open" : ""}`}>
      <button type="button" className="fn-section-header" onClick={onToggle}>
        <span className="fn-chevron" aria-hidden>
          &gt;&gt;
        </span>
        <span className="fn-section-title">{title}</span>
      </button>
      {open && <div className="fn-section-body">{children}</div>}
    </div>
  );
}

export function ComponentFunctionList({
  components,
  dags,
  activeDagId,
  onSelectDag,
  onCreateDag,
  onUnpublishDag,
  onDeleteDag,
  onStartRegister,
  onEditComponent,
  onViewComponent,
  onDeleteComponent,
  onOpenServerSettings,
}: ComponentFunctionListProps) {
  const [open, setOpen] = useState<OpenState>({component: true, dag: true, advanced: false});
  // Open kebab menu anchor: which registered component + the kebab button's
  // screen rect, so the menu pops out to the RIGHT of the kebab (fixed
  // positioning escapes the sidebar's scroll clip). null = all closed.
  const [menuAnchor, setMenuAnchor] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);

  function toggle(key: keyof OpenState) {
    setOpen((prev) => ({...prev, [key]: !prev[key]}));
  }

  return (
    <div className="component-function-list">
      <Section title="组件" open={open.component} onToggle={() => toggle("component")}>
        {/* 顶部「通用组件」拖拽项 = 默认/日常用法：拖到画布即建一个非共享组件节点 */}
        <div
          className="fn-generic-item"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(GENERIC_DRAG_KEY, "generic");
            event.dataTransfer.effectAllowed = "copy";
          }}
          title="拖到画布即创建一个非共享的通用组件节点（默认用法）"
        >
          <span className="fn-generic-name">通用组件</span>
          <span className="fn-generic-hint">拖入即建（不共享）</span>
        </div>

        <div className="fn-component-list">
          {components.filter((c) => c.global).length === 0 ? (
            <p className="fn-empty">还没有注册的组件，点击下方「注册组件」。</p>
          ) : (
            components
              .filter((c) => c.global)
              .map((component) => (
                <div
                  key={component.id}
                  className="fn-component-item"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(COMPONENT_DRAG_KEY, component.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  title="拖到画布即可引用该组件（跨 DAG 复用）"
                >
                  <span className="fn-component-name">{component.name}</span>
                  {component.gitUrl ? (
                    <span className="fn-component-git" title={component.gitUrl}>
                      {component.gitUrl}
                    </span>
                  ) : (
                    <span className="fn-component-git fn-component-git--empty">未配置 git</span>
                  )}
                  <button
                    type="button"
                    className="dag-kebab"
                    title="操作"
                    aria-label="组件操作"
                    onClick={(event) => {
                      // Prevent the card's drag from starting when the user
                      // interacts with the kebab, and don't let the click bubble.
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      if (menuAnchor?.id === component.id) {
                        setMenuAnchor(null);
                      } else {
                        // Pop the menu to the RIGHT of the kebab, same height,
                        // no gap. Fixed positioning so it isn't clipped by the
                        // sidebar's overflow:auto scroll area.
                        setMenuAnchor({id: component.id, top: rect.top, left: rect.right + 4});
                      }
                    }}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    ⋯
                  </button>
                  {menuAnchor?.id === component.id && (
                    <>
                      <div
                        className="dag-menu-backdrop"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuAnchor(null);
                        }}
                      />
                      <div
                        className="dag-menu"
                        style={{
                          position: "fixed",
                          top: menuAnchor.top,
                          left: menuAnchor.left,
                          right: "auto",
                          zIndex: 60,
                        }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="dag-menu-view"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuAnchor(null);
                            onViewComponent(component);
                          }}
                        >
                          查看
                        </button>
                        <button
                          type="button"
                          className="dag-menu-modify"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuAnchor(null);
                            onEditComponent(component);
                          }}
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          className="dag-menu-delete"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuAnchor(null);
                            onDeleteComponent(component);
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
        <button type="button" className="fn-add-btn" onClick={onStartRegister}>
          + 注册组件
        </button>
      </Section>

      <Section title="dag" open={open.dag} onToggle={() => toggle("dag")}>
        <DagListPanel
          dags={dags}
          activeDagId={activeDagId}
          onSelectDag={onSelectDag}
          onCreateDag={onCreateDag}
          onUnpublishDag={onUnpublishDag}
          onDeleteDag={onDeleteDag}
        />
      </Section>

      <Section title="高级" open={open.advanced} onToggle={() => toggle("advanced")}>
        <button type="button" className="fn-add-btn" onClick={onOpenServerSettings}>
          服务器设置
        </button>
      </Section>
    </div>
  );
}
