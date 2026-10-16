import { describe, expect, it, vi } from "vitest";
import {
  ProjectAccessTokenCache,
  ProjectAccessTokenTransientError,
  projectAccessTokenFingerprint,
  type ProjectAccessTokenScope,
} from "../src/project-access-token.js";

const scope: ProjectAccessTokenScope = {
  origin: "https://example.invalid",
  family: "bigmodel",
  accountId: "account",
  organizationId: "org",
  projectId: "project",
  apiKeyId: "key",
  usageScene: 1,
  loginGeneration: "session-1",
};
const START = 1_800_000_000_000;
function token(value = "token", expiresIn = 600, issuedAt = START) {
  return {
    code: 200,
    data: {
      enable: true,
      accessToken: value,
      tokenType: "Bearer",
      expiresIn,
      expiresAt: issuedAt / 1000 + expiresIn,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("ProjectAccessTokenCache", () => {
  it.each([0, 200, "0", "200"])("签发成功码 %s 与管理接口一致", async (code) => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    await expect(cache.resolve(scope, async () => ({ ...token(), code }))).resolves.toMatchObject({
      token: "token",
    });
  });

  it("提前刷新临时失败时并发共享有效 PAT，5 秒退避后恢复，绝不延长 expiresAt", async () => {
    let now = START;
    const cache = new ProjectAccessTokenCache({ now: () => now, random: () => 0 });
    await cache.resolve(scope, async () => token("old"));
    now += 480_000;
    const issue = vi.fn(async () => {
      throw new ProjectAccessTokenTransientError();
    });
    const results = await Promise.all([cache.resolve(scope, issue), cache.resolve(scope, issue)]);
    expect(results).toEqual([
      { enabled: true, token: "old", expiresAt: START + 600_000 },
      { enabled: true, token: "old", expiresAt: START + 600_000 },
    ]);
    now += 4_999;
    await expect(cache.resolve(scope, issue)).resolves.toMatchObject({ token: "old" });
    expect(issue).toHaveBeenCalledTimes(1);
    now++;
    await expect(cache.resolve(scope, issue)).resolves.toMatchObject({ token: "old" });
    expect(issue).toHaveBeenCalledTimes(2);
    now = START + 600_000;
    await expect(cache.resolve(scope, issue)).rejects.toThrow("project_token_transient_failure");
    await expect(cache.resolve(scope, async () => token("new", 600, now))).resolves.toMatchObject({
      token: "new",
    });
  });

  it.each(["clear", "rejected", "expired"])("在途刷新失败时 %s 不能降级到旧 PAT", async (event) => {
    let now = START;
    const cache = new ProjectAccessTokenCache({ now: () => now, random: () => 0 });
    await cache.resolve(scope, async () => token("old"));
    now += 480_000;
    const issued = deferred<unknown>();
    const first = cache.resolve(scope, () => issued.promise);
    const check = expect(first).rejects.toThrow();
    await Promise.resolve();
    let second: Promise<unknown> | undefined;
    if (event === "clear") cache.clear();
    if (event === "expired") now = START + 600_000;
    if (event === "rejected") {
      second = expect(
        cache.resolve(scope, () => issued.promise, await projectAccessTokenFingerprint("old")),
      ).rejects.toThrow();
    }
    issued.reject(new ProjectAccessTokenTransientError());
    await check;
    await second;
  });

  it("401 按失败 PAT 指纹失效，并发合并且迟到的旧 401 不清除新 PAT", async () => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    await cache.resolve(scope, async () => token("old-pat"));
    const fingerprint = await projectAccessTokenFingerprint("old-pat");
    const issue = vi.fn(async () => token("new-pat"));
    const results = await Promise.all([
      cache.resolve(scope, issue, fingerprint),
      cache.resolve(scope, issue, fingerprint),
    ]);
    expect(results.every((value) => value.enabled && value.token === "new-pat")).toBe(true);
    await cache.resolve(scope, issue, fingerprint);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("合并并发签发，在提前刷新窗口之前复用进程内凭据", async () => {
    let now = START;
    const pending = deferred<unknown>();
    const issue = vi.fn(() => pending.promise);
    const cache = new ProjectAccessTokenCache({
      now: () => now,
      random: () => 0,
    });
    const first = cache.resolve(scope, issue);
    const second = cache.resolve(scope, issue);
    pending.resolve(token());
    expect(await first).toEqual({
      enabled: true,
      token: "token",
      expiresAt: START + 600_000,
    });
    expect(await second).toEqual(await first);
    now += 479_999;
    expect(await cache.resolve(scope, issue)).toEqual(await first);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("抖动只提前刷新，并在每次请求前检查 TTL", async () => {
    let now = START;
    const issue = vi.fn(async () => token(String(now), 600, now));
    const cache = new ProjectAccessTokenCache({
      now: () => now,
      random: () => 1,
    });
    await cache.resolve(scope, issue);
    now += 419_999;
    await cache.resolve(scope, issue);
    expect(issue).toHaveBeenCalledTimes(1);
    now++;
    await cache.resolve(scope, issue);
    expect(issue).toHaveBeenCalledTimes(2);
    now += 700_000;
    expect(await cache.resolve(scope, issue)).toMatchObject({
      token: String(now),
    });
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it.each([
    "origin",
    "family",
    "accountId",
    "organizationId",
    "projectId",
    "apiKeyId",
    "usageScene",
    "loginGeneration",
  ] as const)("按 %s 隔离缓存", async (field) => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    const issue = vi.fn(async () => token());
    await cache.resolve(scope, issue);
    const other = {
      ...scope,
      [field]: field === "usageScene" ? 2 : field === "family" ? "zai" : `other-${scope[field]}`,
    };
    await cache.resolve(other as ProjectAccessTokenScope, issue);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("退出期间的迟到结果不得恢复缓存或返回给旧请求", async () => {
    const pending = deferred<unknown>();
    const cache = new ProjectAccessTokenCache({ now: () => START });
    const old = cache.resolve(scope, () => pending.promise);
    const rejected = expect(old).rejects.toMatchObject({
      code: "project_token_scope_invalidated",
    });
    await Promise.resolve();
    cache.clear();
    const issue = vi.fn(async () => token("new-token"));
    await cache.resolve(scope, issue);
    pending.resolve(token("old-token"));
    await rejected;
    expect(await cache.resolve(scope, issue)).toMatchObject({
      token: "new-token",
    });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("签发尚未发出时退出，不再使用旧登录态发送请求", async () => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    const issue = vi.fn(async () => token());
    const pending = cache.resolve(scope, issue);
    cache.clear();
    await expect(pending).rejects.toMatchObject({
      code: "project_token_scope_invalidated",
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("定点失效不影响另一个账号，失败请求允许重新签发", async () => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    const other = { ...scope, accountId: "other" };
    const issue = vi.fn(async () => token());
    await cache.resolve(scope, issue);
    await cache.resolve(other, issue);
    cache.invalidate(scope);
    await cache.resolve(other, issue);
    expect(issue).toHaveBeenCalledTimes(2);
    await expect(
      cache.resolve(scope, async () => {
        throw new Error("network failure");
      }),
    ).rejects.toThrow("network failure");
    await cache.resolve(scope, issue);
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it("仅明确关闭返回 disabled，且不永久缓存关闭开关", async () => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    expect(
      await cache.resolve(scope, async () => ({
        code: 200,
        data: { enable: false },
      })),
    ).toEqual({ enabled: false });
    expect(await cache.resolve(scope, async () => token())).toMatchObject({
      enabled: true,
    });
  });

  it.each([
    {},
    { code: 401, data: { enable: false } },
    { code: 200, data: {} },
    { code: 200, data: { ...token().data, accessToken: "" } },
    { code: 200, data: { ...token().data, tokenType: "Basic" } },
    { code: 200, data: { ...token().data, expiresIn: -1 } },
    { code: 200, data: { ...token().data, expiresAt: START / 1000 } },
  ])("拒绝畸形/过期响应，不把失败降级为 disabled：%j", async (response) => {
    const cache = new ProjectAccessTokenCache({ now: () => START });
    await expect(cache.resolve(scope, async () => response)).rejects.toMatchObject({
      code: "project_token_invalid_response",
    });
  });

  it("计入签发网络耗时，expiresIn 不能从收包时重新起算", async () => {
    let now = START;
    const cache = new ProjectAccessTokenCache({ now: () => now });
    await expect(
      cache.resolve(scope, async () => {
        now += 700_000;
        return token();
      }),
    ).rejects.toMatchObject({ code: "project_token_invalid_response" });
  });

  it.each(["network", "503", "401", "403", "404", "invalid", "disabled"])(
    "未分类异常/业务错误 %s 不视作临时传输故障，不复用旧 PAT，后续可恢复",
    async (failure) => {
      let now = START;
      const cache = new ProjectAccessTokenCache({
        now: () => now,
        random: () => 0,
      });
      await cache.resolve(scope, async () => token("old"));
      now += 480_000;
      const refresh = cache.resolve(scope, async () => {
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "disabled") return { code: 200, data: { enable: false } };
        return failure === "invalid" ? {} : { code: Number(failure) };
      });
      if (failure === "disabled") await expect(refresh).resolves.toEqual({ enabled: false });
      else await expect(refresh).rejects.toThrow();
      const issue = vi.fn(async () => token("new", 600, now));
      await expect(cache.resolve(scope, issue)).resolves.toMatchObject({
        token: "new",
      });
      expect(issue).toHaveBeenCalledOnce();
    },
  );

  it("刷新失败不泄露过期凭据，拒绝认证失败时回退旧 Token", async () => {
    let now = START;
    const cache = new ProjectAccessTokenCache({ now: () => now });
    await cache.resolve(scope, async () => token());
    now += 601_000;
    await expect(cache.resolve(scope, async () => ({ code: 401 }))).rejects.toMatchObject({
      code: "project_token_invalid_response",
    });
  });
});
