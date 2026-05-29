/**
 * AI-safe semantic dependency primitive
 *
 * Rules:
 * 1. No inline lambda
 * 2. No closure capture
 * 3. Only named semantic function
 * 4. Function must be pure
 * 5. Function can only access state/props params
 */

export type DepState = Record<string, unknown>;
export type DepProps = Record<string, unknown>;

type DeepReadonly<T> = {
    readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

export type DepFunction<
    TState extends DepState,
    TProps extends DepProps,
    TResult,
> = (
    state: DeepReadonly<TState>,
    props: DeepReadonly<TProps>,
) => TResult;

export function dep<
    TState extends DepState,
    TProps extends DepProps,
    TResult,
>(
    state: TState,
    props: TProps,
    fn: DepFunction<TState, TProps, TResult>,
): TResult {
    return fn(state, props);
}

function render_when(condition: boolean, fn: () => JSX.Element): JSX.Element | null {
    return condition ? fn() : null;
}

function render_case(condition: boolean, trueFn: () => JSX.Element, falseFn: () => JSX.Element): JSX.Element {
    return condition ? trueFn() : falseFn();
}