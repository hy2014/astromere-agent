type RenderFn<S = any, P = any, E extends Record<string, Function> = any, X = any> = (
    state: S,
    props: P,
    events: E,
    exts?: X
) => JSX.Element;

function render<S, P, E extends Record<string, Function>, X = any>({
   state,
   props,
   fn,
   events,
   exts,
}: {
    state: S;
    props: P;
    fn: RenderFn<S, P, E, X>;
    events: E;
    exts?: X;
}): JSX.Element {
    return fn(state, props, events, exts);
}