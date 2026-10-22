import { describe, expect, it } from "vitest";
import { redactMobileDiagnosticText } from "./e2e/helpers/mobile-pairing.js";

describe("手机配对失败证据脱敏", () => {
  it("移除完整链接和单独出现的 query/hash 配对材料", () => {
    const url = "https://mobile.test/remote/?pairingKey=query-secret#token=hash-secret";
    const value = redactMobileDiagnosticText(`goto ${url}; query-secret; hash-secret`, url);
    expect(value).toContain("https://mobile.test/remote/");
    expect(value).not.toContain("query-secret");
    expect(value).not.toContain("hash-secret");
    expect(value).not.toContain("pairingKey=");
  });
  it("保留资源路径以定位加载错误，去掉其他 URL 的查询参数", () => {
    const value = redactMobileDiagnosticText(
      "failed https://cdn.test/assets/main.js?signature=private: ERR_CONNECTION_RESET",
      "https://mobile.test/remote/?key=one-time-key",
    );
    expect(value).toBe("failed https://cdn.test/assets/main.js ERR_CONNECTION_RESET");
  });
});

it("新手机首页以指定项目内容就绪为准，不等待已退役的配对文案", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { vi } = await import("vitest");
  const { openMobilePairingPage } = await import("./e2e/helpers/mobile-pairing.js");
  const { artifactDir, readySelector } = {
    artifactDir: await mkdtemp(join(tmpdir(), "mobile-pairing-")),
    readySelector: '[data-testid="task-item-remote-fixture"]',
  };
  let ready = false;
  const content = {
    or: () => ({
      first: () => ({
        waitFor: async () => {
          ready = true;
        },
      }),
    }),
    waitFor: async () => {
      expect(ready).toBe(true);
    },
  };
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn(),
    locator: (selector: string) => {
      expect(selector).toBe(readySelector);
      return content;
    },
    getByTestId: () => ({ isVisible: async () => false }),
    getByText: () => {
      throw new Error("旧配对文案已删除");
    },
  };
  try {
    await openMobilePairingPage(
      page as unknown as import("playwright-core").Page,
      "https://mobile.test/remote/?key=fixture",
      { artifactDir, readySelector, caseMarker: "E2E_MOBILE", phase: "initial" },
    );
    expect(ready).toBe(true);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
