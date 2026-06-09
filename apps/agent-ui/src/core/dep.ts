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
 * renderView — dispatch 到另一个 View 组件
 *
 * 用于 renderFn 内部需要挂载一个拥有独立 useState/WriteState 的 View 组件时。
 * 语义上等价于 <XxxView {...props} />，但可被 checker 静态分析识别。
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
 * renderList — 列表渲染
 *
 * 替代 rows.map((row) => render({ fn, state, props, events, exts: { row } }))。
 * 每条 item 自动作为 ext 传入 renderFn。
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