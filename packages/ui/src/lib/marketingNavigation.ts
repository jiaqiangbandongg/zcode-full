import { createStore } from "zustand/vanilla";
import { logger } from "@/logger.js";
import type { MarketingAction } from "@zcode/shared";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

export type MarketingNavigationTarget = Extract<MarketingAction, { type: "navigate" }>["args"];
export const marketingSettingsSections = {
  general: "general",
  appearance: "appearance",
  models: "modelProvider",
  browser: "browser",
  computer_use: "computerUse",
  memory: "memory",
  subagents: "subagents",
  plugins: "plugin",
  mcp: "mcp",
  skills: "skill",
  commands: "commands",
  hooks: "hooks",
  usage: "usage",
} as const satisfies Record<string, SettingsSectionId>;
type Request = { id: number; target: MarketingNavigationTarget; finish: (error?: Error) => void };
export const marketingNavigation = createStore<{ request: Request | null }>(() => ({
  request: null,
}));
let sequence = 0;

/** 只关联当前窗口的一次导航，迟到页面不能确认下一次请求。 */
export function finishMarketingNavigation(id: number, error?: Error) {
  const request = marketingNavigation.getState().request;
  if (request?.id === id) {
    logger.info("[marketing-touch] navigation destination acknowledged", {
      requestId: id,
      page: request.target.page,
      succeeded: !error,
    });
    request.finish(error);
  }
}
export async function requestMarketingNavigation(
  target: MarketingNavigationTarget,
  signal: AbortSignal,
  dispatch: () => void,
) {
  signal.throwIfAborted();
  if (marketingNavigation.getState().request) throw new Error("marketing_navigation_busy");
  const id = ++sequence;
  logger.info("[marketing-touch] navigation requested", {
    requestId: id,
    page: target.page,
    section: target.page === "settings" ? target.section : undefined,
  });
  const completion = new Promise<void>((resolve, reject) => {
    marketingNavigation.setState({
      request: { id, target, finish: (error) => (error ? reject(error) : resolve()) },
    });
  });
  try {
    const waiting = waitForMarketingCapability(completion, signal, 30_000);
    try {
      dispatch();
    } catch {
      finishMarketingNavigation(id, new Error("marketing_navigation_unavailable"));
    }
    await waiting;
  } finally {
    if (marketingNavigation.getState().request?.id === id)
      marketingNavigation.setState({ request: null });
  }
}
export async function waitForMarketingCapability<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("marketing_capability_cancelled"));
        timer = setTimeout(() => reject(new Error("marketing_capability_timeout")), timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
