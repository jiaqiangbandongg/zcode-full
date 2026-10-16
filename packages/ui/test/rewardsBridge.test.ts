import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { installRewardsPageBridge, createRewardsInjectionScript } from "@zcode/shared";

it("bridge 保留当前快照、通知及退订，凭据不出现在事件中", () => {
  const window = new EventTarget() as EventTarget & { zcodeBridge: any };
  const values = new Map<string, string>([["oauth:bigmodel:access_token", "old-account"]]);
  const context = {
    window,
    CustomEvent,
    localStorage: {
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  };
  runInNewContext(`(${installRewardsPageBridge.toString()})()`, context);
  expect(values.size).toBe(0);
  const bridge = window.zcodeBridge;
  expect(bridge.getTheme()).toBeNull();
  const themes: string[] = [];
  const off = bridge.onThemeChange((value: string) => themes.push(value));
  const snapshot = {
    theme: "zai-light" as const,
    locale: "en-US" as const,
    auth: { status: "ready" as const, provider: "zai" as const, revision: 1 },
  };
  window.dispatchEvent(new CustomEvent("zcode-referrals-context", { detail: snapshot }));
  expect(bridge.getTheme()).toBeNull();
  expect(bridge.getAuthState()).toBeNull();
  runInNewContext(
    createRewardsInjectionScript(snapshot, { oauth: "fixture-token", jwt: "fixture-jwt" }),
    context,
  );
  expect(themes).toEqual(["zai-light"]);
  expect(bridge.getAuthState()).toEqual(snapshot.auth);
  expect(values.get("oauth:zai:access_token")).toBe("fixture-token");
  off();
  runInNewContext(
    createRewardsInjectionScript(
      {
        ...snapshot,
        theme: "zai-dark",
        auth: { status: "anonymous", provider: null, revision: 2 },
      },
      {},
    ),
    context,
  );
  expect(themes).toEqual(["zai-light"]);
  expect(bridge.getTheme()).toBe("zai-dark");
  expect(values.size).toBe(0);
  expect(bridge.notifyPurchaseComplete).toBeUndefined();
});
