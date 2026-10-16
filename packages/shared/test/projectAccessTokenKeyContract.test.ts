import { describe, expect, it, vi } from "vitest";
import { ProjectAccessTokenClient } from "../src/project-access-token-client.js";

const scope = {
  origin: "https://example.invalid",
  family: "bigmodel" as const,
  loginToken: "login",
  accountId: "user",
};
const team = { organizationId: "org", projectId: "project" };
const teamKey = { apiKey: "key", name: "zcode-team-api-key", keyType: 2 };
const personalKey = { apiKey: "key", name: "zcode-api-key" };
function fixture(options: { keys?: unknown[]; created?: unknown; organizations?: unknown[] } = {}) {
  const request = vi.fn(async (url: string, init: RequestInit) => {
    let data: unknown;
    if (url.endsWith("/getCustomerInfo"))
      data = {
        organizations: options.organizations ?? [
          { organizationId: "org", projects: [{ projectId: "project" }] },
        ],
      };
    else if (url.endsWith("/api_keys"))
      data = init.method === "POST" ? options.created : (options.keys ?? []);
    else
      data = {
        accessToken: "short-token",
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      };
    return { code: 200, data };
  });
  return { request, client: new ProjectAccessTokenClient({ request }) };
}

describe("专用 Key 管理兼容契约", () => {
  it.each([
    { ...teamKey, name: "other" },
    { ...teamKey, keyType: 1 },
    { ...teamKey, keyType: undefined },
    { ...teamKey, apiKey: " " },
  ])("拒绝错误团队创建结果 %j，不换证", async (created) => {
    const f = fixture({ created });
    await expect(f.client.resolve({ ...scope, team })).rejects.toThrow(
      "project_token_invalid_response",
    );
    expect(f.request.mock.calls.some(([url]) => url.endsWith("/access_tokens"))).toBe(false);
  });

  it.each([false, true])("无关缺 ID 条目不影响已有专用 Key，团队=%s", async (isTeam) => {
    const f = fixture({
      keys: [{ name: "other", apiKey: "" }, { name: "another" }, isTeam ? teamKey : personalKey],
    });
    await expect(
      f.client.resolve({ ...scope, ...(isTeam ? { team } : {}) }),
    ).resolves.toMatchObject({ apiKeyId: "key" });
    expect(
      f.request.mock.calls.filter(
        ([url, init]) => url.endsWith("/api_keys") && init.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("个人同名 Key 缺 ID 时失败，不重复创建", async () => {
    const f = fixture({ keys: [{ name: "zcode-api-key", apiKey: "" }], created: personalKey });
    await expect(f.client.resolve(scope)).rejects.toThrow("project_token_invalid_response");
    expect(f.request.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  });

  it("团队跳过不可用同名 Key，创建后严格校验；个人创建无需返回同名", async () => {
    const f = fixture({ keys: [{ ...teamKey, apiKey: "" }], created: teamKey });
    await expect(f.client.resolve({ ...scope, team })).resolves.toMatchObject({ apiKeyId: "key" });
    const personal = fixture({ created: { apiKey: "personal-key", name: "server-name" } });
    await expect(personal.client.resolve(scope)).resolves.toMatchObject({
      apiKeyId: "personal-key",
    });
  });

  it("桌面跳过空组织 ID 和带空白的团队项目类型", async () => {
    const f = fixture({
      keys: [personalKey],
      organizations: [
        { organizationId: "", organizationName: "默认机构", projects: [{ projectId: "bad" }] },
        {
          organizationId: "org",
          projects: [
            { projectId: "team", projectName: "默认项目", projectType: " 2 " },
            { projectId: "personal", projectType: 1 },
          ],
        },
      ],
    });
    await expect(f.client.resolve(scope)).resolves.toMatchObject({
      organizationId: "org",
      projectId: "personal",
    });
  });

  it("团队归属比较保留 ID 去空白行为", async () => {
    const f = fixture({
      keys: [teamKey],
      organizations: [{ organizationId: " org ", projects: [{ projectId: " project " }] }],
    });
    await expect(f.client.resolve({ ...scope, team })).resolves.toMatchObject(team);
  });
});

it("个人项目选择策略隔离内存和持久化 ID，重启后各自复用", async () => {
  const f = fixture({
    keys: [personalKey],
    organizations: [
      {
        organizationId: "org",
        projects: [
          { projectId: "team", projectName: "默认项目", projectType: 2 },
          { projectId: "personal", projectType: 1 },
        ],
      },
    ],
  });
  const values = new Map<string, string>();
  const locationStore = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  const client = new ProjectAccessTokenClient({ request: f.request, locationStore });
  await expect(client.resolve(scope)).resolves.toMatchObject({ projectId: "personal" });
  await expect(
    client.resolve({ ...scope, personalProjectSelection: "default" }),
  ).resolves.toMatchObject({ projectId: "team" });
  expect(values.size).toBe(2);
  f.request.mockClear();
  const restarted = new ProjectAccessTokenClient({ request: f.request, locationStore });
  await expect(restarted.resolve(scope)).resolves.toMatchObject({ projectId: "personal" });
  await expect(
    restarted.resolve({ ...scope, personalProjectSelection: "default" }),
  ).resolves.toMatchObject({ projectId: "team" });
  expect(f.request.mock.calls.every(([url]) => url.endsWith("/access_tokens"))).toBe(true);
  expect(f.request).toHaveBeenCalledTimes(2);
});
