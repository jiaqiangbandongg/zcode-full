import { describe, expect, it } from "vitest";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("BrowserOAuthCredentialRepo", () => {
  it("saves and restores a complete ZAI web session", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    repo.saveTokenSet(
      {
        zcodeJwtToken: "jwt-token",
        zaiAccessToken: "zai-token",
      },
      "zai",
    );
    repo.saveUserInfo(
      {
        user_id: "u_1",
        name: "Ada",
        email: "ada@example.com",
        avatar: "https://example.com/a.png",
      },
      "zai",
    );
    repo.setActiveProvider("zai");

    expect(repo.loadCachedSession()).toEqual({
      id: "u_1",
      username: "Ada",
      displayName: "Ada",
      avatarUrl: "https://example.com/a.png",
    });
    expect(localStorage.getItem("zcodejwttoken")).toBe("jwt-token");
    expect(localStorage.getItem("oauth:zai:access_token")).toBe("zai-token");
  });

  it("clears partial ZAI sessions instead of restoring them", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    localStorage.setItem("oauth:active_provider", "zai");
    localStorage.setItem("zcodejwttoken", "jwt-token");
    localStorage.setItem("oauth:zai:user_info", JSON.stringify({ user_id: "u_1", name: "Ada" }));

    expect(repo.loadCachedSession()).toBeNull();
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
    expect(localStorage.getItem("zcodejwttoken")).toBeNull();
    expect(localStorage.getItem("oauth:zai:user_info")).toBeNull();
  });

  // private 分享的 owner 身份是 provider 特定的（bigmodel 是数字 ID，z.ai 是 UUID），
  // 所以 BigModel 登录必须能独立存取，不能被 zai 的 key 段和判定挡掉。
  it("saves and restores a complete BigModel web session", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    repo.saveTokenSet({ zcodeJwtToken: "jwt-token", accessToken: "bigmodel-token" }, "bigmodel");
    repo.saveUserInfo({ user_id: "53291785835589288", name: "Ada" }, "bigmodel");
    repo.setActiveProvider("bigmodel");

    expect(repo.loadCachedSession()).toEqual({
      id: "53291785835589288",
      username: "Ada",
      displayName: "Ada",
    });
    expect(repo.loadZCodeJwtToken()).toBe("jwt-token");
    expect(localStorage.getItem("oauth:bigmodel:access_token")).toBe("bigmodel-token");
    // 不能污染 zai 的 key 段
    expect(localStorage.getItem("oauth:zai:access_token")).toBeNull();
  });

  it("切换 provider 时清掉上一个身份的残片", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    repo.saveTokenSet({ zcodeJwtToken: "jwt-zai", zaiAccessToken: "zai-token" }, "zai");
    repo.saveUserInfo({ user_id: "uuid-1", name: "Ada" }, "zai");
    repo.setActiveProvider("zai");

    repo.clearAll();
    repo.saveTokenSet({ zcodeJwtToken: "jwt-bm", accessToken: "bm-token" }, "bigmodel");
    repo.saveUserInfo({ user_id: "53291785835589288", name: "Ada" }, "bigmodel");
    repo.setActiveProvider("bigmodel");

    expect(localStorage.getItem("oauth:zai:access_token")).toBeNull();
    expect(localStorage.getItem("oauth:zai:user_info")).toBeNull();
    expect(repo.loadCachedSession()?.id).toBe("53291785835589288");
  });

  it("只读返回当前 provider 的账号展示资料，缺 JWT 或资料损坏也不清理存储", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    expect(repo.loadActiveAccount()).toBeNull();
    repo.saveUserInfo(
      { user_id: "53291785835589288", name: "Ada", avatar: "https://example.com/a.png" },
      "bigmodel",
    );
    repo.setActiveProvider("bigmodel");
    expect(repo.loadActiveAccount()).toEqual({
      provider: "bigmodel",
      userInfo: {
        id: "53291785835589288",
        username: "Ada",
        displayName: "Ada",
        avatarUrl: "https://example.com/a.png",
      },
    });

    localStorage.setItem("oauth:bigmodel:user_info", "{not json");
    expect(repo.loadActiveAccount()).toBeNull();
    // 展示读取不是登录门禁：不能像 loadCachedSessionState 那样顺手清理残缺凭据。
    expect(localStorage.getItem("oauth:active_provider")).toBe("bigmodel");
    expect(localStorage.getItem("oauth:bigmodel:user_info")).toBe("{not json");
  });

  it("clears an expired JWT session and requests reauthentication", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage }, { now: () => 2_000_000 });

    localStorage.setItem("oauth:active_provider", "zai");
    localStorage.setItem("zcodejwttoken", createUnsignedJwt({ exp: 1_000 }));
    localStorage.setItem("oauth:zai:access_token", "zai-token");
    localStorage.setItem("oauth:zai:user_info", JSON.stringify({ user_id: "u_1", name: "Ada" }));

    expect(repo.loadCachedSessionState()).toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
    expect(localStorage.getItem("zcodejwttoken")).toBeNull();
    expect(localStorage.getItem("oauth:zai:access_token")).toBeNull();
    expect(localStorage.getItem("oauth:zai:user_info")).toBeNull();
  });

  it("登录记录跨标签页可取回，取出即删，清理登录凭据时保留", () => {
    const localStorage = new MemoryStorage();
    const tabA = new BrowserOAuthCredentialRepo({ localStorage });
    const tabB = new BrowserOAuthCredentialRepo({ localStorage });
    const login = {
      nonce: "nonce-1",
      provider: "bigmodel" as const,
      redirectUri: "https://zcode.z.ai/remote/v4?sid=device-1",
    };

    tabA.savePendingLogin(login);
    // 回调页可能先跑登录门禁，残缺凭据清理不能顺带删掉进行中的登录。
    tabB.clearAll();

    expect(tabB.takePendingLogin("nonce-1")).toEqual(login);
    expect(tabB.takePendingLogin("nonce-1")).toBeNull();
    expect(localStorage.getItem("oauth_pending_logins")).toBeNull();
  });

  it("只取 nonce 匹配的登录记录，不匹配时不改动其他记录", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });
    const loginA = { nonce: "a", provider: "zai" as const, redirectUri: "https://zcode.z.ai/a" };
    const loginB = {
      nonce: "b",
      provider: "bigmodel" as const,
      redirectUri: "https://zcode.z.ai/b",
    };
    repo.savePendingLogin(loginA);
    repo.savePendingLogin(loginB);
    const stored = localStorage.getItem("oauth_pending_logins");

    expect(repo.takePendingLogin("unknown")).toBeNull();
    expect(localStorage.getItem("oauth_pending_logins")).toBe(stored);
    expect(repo.takePendingLogin("a")).toEqual(loginA);
    expect(repo.takePendingLogin("b")).toEqual(loginB);
  });

  it("最多保留最近 5 条登录记录", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });
    for (let index = 0; index < 6; index += 1) {
      repo.savePendingLogin({
        nonce: `nonce-${index}`,
        provider: "zai",
        redirectUri: "https://zcode.z.ai/remote/v4",
      });
    }

    expect(repo.takePendingLogin("nonce-0")).toBeNull();
    expect(repo.takePendingLogin("nonce-1")).not.toBeNull();
    expect(repo.takePendingLogin("nonce-5")).not.toBeNull();
  });

  it("损坏或字段不完整的登录记录视为不存在", () => {
    const localStorage = new MemoryStorage();
    const repo = new BrowserOAuthCredentialRepo({ localStorage });

    localStorage.setItem("oauth_pending_logins", "{not json");
    expect(repo.takePendingLogin("nonce-1")).toBeNull();

    localStorage.setItem(
      "oauth_pending_logins",
      JSON.stringify([
        { nonce: "nonce-1", provider: "not-a-provider", redirectUri: "https://zcode.z.ai" },
        { nonce: "nonce-2", provider: "zai", redirectUri: " " },
      ]),
    );
    expect(repo.takePendingLogin("nonce-1")).toBeNull();
    expect(repo.takePendingLogin("nonce-2")).toBeNull();

    const login = { nonce: "nonce-3", provider: "zai" as const, redirectUri: "https://zcode.z.ai" };
    repo.savePendingLogin(login);
    expect(repo.takePendingLogin("nonce-3")).toEqual(login);
  });
});
