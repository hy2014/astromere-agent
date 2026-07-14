import type {Dag} from "../../types";

export type DagListViewProps = {
  dags: Dag[];
  onEnter: (dagId: string) => void;
};

// Center landing view in dag mode: a catalog table of every *published* DAG.
// Columns: name / description / cron / action(进入). Clicking 进入 jumps to
// that DAG's detail canvas (handled by the parent via onEnter).
export function DagListView({dags, onEnter}: DagListViewProps) {
  const published = dags.filter((dag) => dag.status === "published");

  return (
    <div className="dag-list-view">
      <div className="dag-list-view-head">
        <h2 className="dag-list-view-title">已发布的 DAG</h2>
        <span className="dag-list-view-count">{published.length} 个</span>
      </div>
      {published.length === 0 ? (
        <p className="dag-list-view-empty">
          还没有已发布的 DAG。在左侧「dag」里新建并发布后，会出现在这里。
        </p>
      ) : (
        <table className="dag-table">
          <thead>
            <tr>
              <th className="dag-table-col-name">名称</th>
              <th className="dag-table-col-desc">介绍</th>
              <th className="dag-table-col-cron">cron 表达式</th>
              <th className="dag-table-col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            {published.map((dag) => (
              <tr key={dag.id}>
                <td className="dag-table-name">{dag.name}</td>
                <td className="dag-table-desc">{dag.description || "—"}</td>
                <td className="dag-table-cron">{dag.cron || "—"}</td>
                <td className="dag-table-action">
                  <button
                    type="button"
                    className="dag-enter-btn"
                    onClick={() => onEnter(dag.id)}
                  >
                    进入
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
