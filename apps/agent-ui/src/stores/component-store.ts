import type {Component} from "../types";

let components: Component[] = [];
let listeners: Array<(components: Component[]) => void> = [];

export function getComponents(): Component[] {
  return [...components];
}

export function setComponents(next: Component[]): void {
  components = [...next];
  for (const listener of listeners) {
    listener(components);
  }
}

export function addComponent(component: Component): void {
  setComponents([component, ...components]);
}

export function updateComponent(component: Component): void {
  setComponents(
    components.map((candidate) =>
      candidate.id === component.id ? component : candidate,
    ),
  );
}

export function removeComponent(componentId: string): void {
  setComponents(components.filter((candidate) => candidate.id !== componentId));
}

export function subscribe(listener: (components: Component[]) => void): () => void {
  listeners.push(listener);
  listener(components);
  return () => {
    listeners = listeners.filter((candidate) => candidate !== listener);
  };
}
