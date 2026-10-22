/**
 * A system tools read from. It is given only operations the tool's
 * tool.yml lists, and returns the result as text; the tools server caps
 * and wraps that text before the model sees it.
 */
export interface Upstream {
  call(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string>;
  /** Stops whatever the upstream started for the run. */
  close?(): Promise<void>;
}

export type Upstreams = Readonly<Record<string, Upstream>>;

/** Operations served by the tools server itself, with no system behind them. */
export const builtinUpstream: Upstream = {
  call(operation, args) {
    if (operation === "echo")
      return Promise.resolve(typeof args.text === "string" ? args.text : "");
    return Promise.reject(new Error(`builtin has no operation "${operation}"`));
  },
};

export const DEFAULT_UPSTREAMS: Upstreams = { builtin: builtinUpstream };
