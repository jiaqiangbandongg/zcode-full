import { expect, it, vi } from "vitest";
import { requestPluginReferenceCatalog } from "../src/zcode-agent/pluginReferenceCatalogRequest.js";
const params = { workspace: { workspacePath: "/w", workspaceKey: "/identity" }, sessionId: "s" };
const result = { authority: "session", plugins: [] };
it("新入口保留 workspace/session 参数，旧 Agent 仅 -32601 回退", async () => {
  const request = vi.fn().mockRejectedValueOnce({ code: -32601 }).mockResolvedValue(result);
  expect(await requestPluginReferenceCatalog({ request }, params)).toBe(result);
  expect(request.mock.calls.map((x) => x.slice(0, 2))).toEqual([
    ["plugins/referenceCatalogWithCategory", params],
    ["plugins/referenceCatalog", params],
  ]);
});
it.each([-32602, -32000, undefined])(
  "其他错误 %s 原样返回，不混入 workspace 数据",
  async (code) => {
    const error = Object.assign(new Error("failed"), { code });
    const request = vi.fn().mockRejectedValue(error);
    await expect(requestPluginReferenceCatalog({ request }, params)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("支持新入口时仅请求一次", async () => {
  const request = vi.fn().mockResolvedValue(result);
  expect(await requestPluginReferenceCatalog({ request }, params)).toBe(result);
  expect(request).toHaveBeenCalledTimes(1);
});
