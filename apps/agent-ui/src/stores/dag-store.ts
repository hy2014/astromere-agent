import type {Dag, DagDetail} from "../types";

let dags: Dag[] = [];
let activeDagId: string | null = null;
let listeners: Array<(state: {dags: Dag[]; activeDagId: string | null}) => void> = [];

function emit(): void {
  for (const listener of listeners) {
    listener({dags: [...dags], activeDagId});
  }
}

export function getDags(): Dag[] {
  return [...dags];
}

export function setDags(next: Dag[]): void {
  dags = [...next];
  emit();
}

export function addDag(dag: Dag): void {
  dags = [dag, ...dags];
  activeDagId = dag.id;
  emit();
}

export function updateDag(dag: Dag): void {
  dags = dags.map((candidate) => (candidate.id === dag.id ? dag : candidate));
  emit();
}

export function removeDag(dagId: string): void {
  dags = dags.filter((candidate) => candidate.id !== dagId);
  if (activeDagId === dagId) {
    activeDagId = dags[0]?.id ?? null;
  }
  emit();
}

export function getActiveDagId(): string | null {
  return activeDagId;
}

export function setActiveDagId(dagId: string | null): void {
  activeDagId = dagId;
  emit();
}

export function subscribe(
  listener: (state: {dags: Dag[]; activeDagId: string | null}) => void,
): () => void {
  listeners.push(listener);
  listener({dags: [...dags], activeDagId});
  return () => {
    listeners = listeners.filter((candidate) => candidate !== listener);
  };
}

export function dagDetailToDag(detail: DagDetail): Dag {
  const {nodes: _nodes, edges: _edges, ...dag} = detail;
  return dag;
}
