import { createElement, type ComponentType } from "react";

type RenderFn<S = any, P = any, E = any, M = any> = (
    state: S,
    props: P,
    events: E,
    memo: M,
) => JSX.Element;

export function render<S, P, E, M>({
    state,
    props,
    fn,
    events,
    memo,
}: {
    state: S;
    props: P;
    fn: RenderFn<S, P, E, M>;
    events: E;
    memo: M;
}): JSX.Element {
    return fn(state, props, events, memo);
}

/**
 * renderView — dispatch to another View component
 *
 * Used inside a renderFn when you need to mount a View component that owns
 * its own independent useState/WriteState. Semantically equivalent to
 * <XxxView {...props} />, but recognizable by the checker's static analysis.
 *
 * @example
 * function renderContent({ section }, {}, {}) {
 *   if (section === "remote") {
 *     return renderView({ fn: RemoteSettingsPanelView, props: {} });
 *   }
 * }
 */
export function renderView<P = Record<string, any>>({
    fn,
    props,
}: {
    fn: ComponentType<P>;
    props: P;
}): JSX.Element {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createElement(fn as any, props as any);
}

type RenderListItemFn<S = any, P = any, E = any> = (
    state: S,
    props: P,
    events: E,
    ext: any,
) => JSX.Element;

/**
 * renderList — render a list
 *
 * Replaces rows.map((row) => render({ fn, state, props, events, exts: { row } })).
 * Each item is automatically passed as `ext` into the renderFn.
 *
 * @example
 * renderList({
 *   state: {},
 *   props: {},
 *   fn: renderRow,
 *   events: { onDelete },
 *   items: rows,
 * })
 */
export function renderList<S, P, E>({
    state,
    props,
    fn,
    events,
    items,
}: {
    state: S;
    props: P;
    fn: RenderListItemFn<S, P, E>;
    events: E;
    items: any[];
}): JSX.Element[] {
    return items.map((item) => fn(state, props, events, item));
}