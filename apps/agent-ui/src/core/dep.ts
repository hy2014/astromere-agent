type RenderFn<S = any, P = any, E = any, X = any> = (
    state: S,
    props: P,
    events: E,
    exts?: X,
    memo?: any,
) => JSX.Element;

export function render<S, P, E, X = any>({
    state,
    props,
    fn,
    events,
    exts,
    memo,
}: {
    state: S;
    props: P;
    fn: RenderFn<S, P, E, X>;
    events: E;
    exts?: X;
    memo?: any;
}): JSX.Element {
    return fn(state, props, events, exts, memo);
}