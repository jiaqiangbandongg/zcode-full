// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GlobalDatabaseStartupLoading } from "@/root/GlobalDatabaseStartupLoading.js";

it("explains FULL, provides manual recovery, and never claims all changes rolled back", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(GlobalDatabaseStartupLoading, {
        state: {
          schemaVersion: 1,
          startupId: "startup",
          attemptId: "diagnostic-1",
          sequence: 2,
          phase: "failed",
          failedPhase: "preparing_session_storage",
          errorCode: "storage_full",
          startedAt: 1,
          updatedAt: 2,
          disk: [],
        },
        onRetry: () => {},
        onCopy: async () => {},
        onExit: () => {},
      }),
    ),
  );
  expect(html).toContain("存储空间不足或已达到容量限制");
  expect(html).toContain("系统临时目录");
  expect(html).toContain("diagnostic-1");
  expect(html).toContain("重试");
  expect(html).not.toContain("原数据库已保留");
});

function renderStartup(
  state: import("@zcode/shared").DatabaseStartupState | null,
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(GlobalDatabaseStartupLoading, {
        state,
        onRetry() {},
        onCopy: async () => {},
        onExit() {},
      }),
    ),
  );
}
const baseState: import("@zcode/shared").DatabaseStartupState = {
  schemaVersion: 1,
  startupId: "silent",
  attemptId: "silent",
  sequence: 1,
  phase: "preparing_host_storage",
  startedAt: 1,
  updatedAt: 2,
  disk: [],
};
it("SILENTDB-01/08: every normal preparation phase has no visible text or buttons", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const databasePhase of [
      "checking",
      "waiting_for_lock",
      "committing",
      "maintaining",
      "ready",
    ] as const) {
      const html = renderStartup({ ...baseState, databasePhase }, locale);
      expect(html).toContain('data-testid="root-startup-loading"');
      expect(html).not.toContain('data-testid="database-startup-status"');
      expect(html).not.toMatch(/<(h1|p|button)(\s|>)/);
    }
    expect(renderStartup(null, locale)).not.toMatch(/<(h1|p|button)(\s|>)/);
    expect(renderStartup({ ...baseState, phase: "starting_services" }, locale)).not.toMatch(
      /<(h1|p|button)(\s|>)/,
    );
  }
});
it("SILENTDB-02/05: migration facts control initialization, upgrade, saving and finishing text", () => {
  const migration = { kind: "upgrade" as const, executedCount: 1, committedCount: 0 };
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "migrating",
      migration,
      currentMigration: migration,
    }),
  ).toContain("正在升级本地数据");
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "committing",
      finalDatabase: true,
      migration,
      currentMigration: migration,
    }),
  ).toContain("正在保存更新");
  expect(
    renderStartup({
      ...baseState,
      phase: "starting_services",
      migration: { ...migration, committedCount: 1 },
    }),
  ).toContain("正在完成启动");
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "checking",
      migration: { ...migration, committedCount: 1 },
    }),
  ).not.toContain("正在完成启动");
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "migrating",
      migration: { ...migration, kind: "initialize" },
      currentMigration: { ...migration, kind: "initialize" },
    }),
  ).toContain("正在初始化本地数据");
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "waiting_for_lock",
      migration,
      currentMigration: migration,
    }),
  ).toContain("正在等待数据库准备");
});

it("SILENTDB-01: silent UI mounts no timer and migration-to-failure clears the progress timer", async () => {
  vi.useFakeTimers();
  const interval = vi.spyOn(globalThis, "setInterval");
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = async (state: import("@zcode/shared").DatabaseStartupState) => {
    await act(async () =>
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(GlobalDatabaseStartupLoading, {
            state,
            onRetry() {},
            onCopy: async () => {},
            onExit() {},
          }),
        ),
      ),
    );
  };
  try {
    await show(baseState);
    expect(container.textContent).toBe("");
    expect(interval).not.toHaveBeenCalled();
    const migration = { kind: "upgrade" as const, executedCount: 0, committedCount: 0 };
    await show({
      ...baseState,
      databasePhase: "migrating",
      migration,
      currentMigration: migration,
    });
    expect(container.textContent).toContain("正在升级本地数据");
    expect(interval).toHaveBeenCalledTimes(1);
    await show({ ...baseState, phase: "failed", errorCode: "storage_full", migration });
    expect(container.textContent).toContain("存储空间不足");
    expect(vi.getTimerCount()).toBe(0);
    await show({ ...baseState, attemptId: "retry" });
    expect(container.textContent).toBe("");
    expect(interval).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    interval.mockRestore();
    vi.useRealTimers();
  }
});

it("SILENTDB-05: intermediate database commits and maintenance never announce global saving or finishing", () => {
  const migration = { kind: "upgrade" as const, executedCount: 1, committedCount: 1 };
  for (const databasePhase of ["checking", "committing", "maintaining", "ready"] as const) {
    const html = renderStartup({
      ...baseState,
      databasePhase,
      migration,
      currentMigration: migration,
      finalDatabase: false,
    });
    expect(html).toContain("正在升级本地数据");
    expect(html).not.toContain("正在保存更新");
    expect(html).not.toContain("正在完成启动");
  }
  expect(
    renderStartup({
      ...baseState,
      databasePhase: "ready",
      migration,
      currentMigration: migration,
      finalDatabase: true,
    }),
  ).toContain("正在完成启动");
});
