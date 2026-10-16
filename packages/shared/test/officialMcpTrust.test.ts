/* 官方 MCP 信任判定（spec §5.1 / §5.2）。
 *
 * 规则：目标 origin 等于当前 ZCode API origin（https）。
 *
 * 2026-08 决策变更：移除了「pluginId 必须以 `@zcode-plugins-official` 结尾」这道检查。
 * 它会让官方插件在发布到官方 marketplace 之前无法对真实端点自测（本地装的插件 id 是
 * `@inline` 或 `@<本地 marketplace>`），而 dev loopback 开关只放开 http loopback、救不了
 * https 端点。因此这里的承重项只剩 **origin 相等**（防外泄）。
 */
import { describe, expect, it } from "vitest";
import {
  createOfficialMcpTrustedOriginRegistry,
  isOfficialMcpOriginTrusted,
} from "../src/official-mcp-auth.js";

const OFFICIAL_PLUGIN = "zcode-tools@zcode-plugins-official";
const ZCODE_ORIGIN = "https://zcode.z.ai";

function check(input: {
  devTrustedOriginsRaw?: string;
  origin: string;
  pluginId?: string;
  zcodeApiOrigin?: string | undefined;
}) {
  return isOfficialMcpOriginTrusted({
    devTrustedOriginsRaw: input.devTrustedOriginsRaw,
    origin: input.origin,
    pluginId: input.pluginId ?? OFFICIAL_PLUGIN,
    zcodeApiOrigin: "zcodeApiOrigin" in input ? input.zcodeApiOrigin : ZCODE_ORIGIN,
  });
}

describe("isOfficialMcpOriginTrusted", () => {
  it("trusts the current ZCode API origin", () => {
    expect(check({ origin: ZCODE_ORIGIN })).toEqual({ detail: "ok", trusted: true });
    // 带路径的 URL 归一化到同一 origin（真实端点形态：POST /api/v1/mcp/server/:mcp_group）
    expect(check({ origin: `${ZCODE_ORIGIN}/api/v1/mcp/server/image_search` })).toMatchObject({
      trusted: true,
    });
  });

  it("accepts any plugin id at the correct origin", () => {
    // pluginId 不再参与判定：inline、本地 marketplace、第三方一律按 origin 判断。
    for (const pluginId of [
      "official-tools@zcode-plugins-local",
      "dev-official-mcp@inline",
      "evil@third-party",
      "zcode-tools",
    ]) {
      expect(check({ origin: ZCODE_ORIGIN, pluginId })).toEqual({ detail: "ok", trusted: true });
    }
  });

  it("still rejects those same plugins at a wrong origin", () => {
    // 移除 marketplace 检查后，origin 是唯一屏障——必须确认它没被一起放松。
    for (const pluginId of ["evil@third-party", "official-tools@zcode-plugins-local"]) {
      expect(check({ origin: "https://attacker.example", pluginId })).toEqual({
        detail: "origin_mismatch",
        trusted: false,
      });
    }
  });

  it("rejects any origin other than the resolved ZCode API origin", () => {
    for (const origin of [
      "https://attacker.example",
      "https://zcode.z.ai.attacker.example",
      "https://evil-zcode.z.ai",
      `${ZCODE_ORIGIN}:8443`,
    ]) {
      expect(check({ origin })).toEqual({ detail: "origin_mismatch", trusted: false });
    }
  });

  it("rejects http even when the host matches", () => {
    // origin 相等是承重项，但仍必须是 https——明文会让凭证在链路上暴露
    expect(check({ origin: "http://zcode.z.ai" })).toMatchObject({ trusted: false });
  });

  it("rejects credential-bearing URLs on either side", () => {
    expect(check({ origin: `https://user:pass@zcode.z.ai` })).toMatchObject({ trusted: false });
    expect(
      check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: "https://user:pass@zcode.z.ai" }),
    ).toMatchObject({ trusted: false });
  });

  it("fails closed when the ZCode API origin cannot be resolved", () => {
    expect(check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: undefined })).toEqual({
      detail: "zcode_origin_unresolved",
      trusted: false,
    });
    expect(check({ origin: ZCODE_ORIGIN, zcodeApiOrigin: "not-a-url" })).toEqual({
      detail: "zcode_origin_unresolved",
      trusted: false,
    });
  });

  it("rejects malformed input without throwing", () => {
    expect(check({ origin: "" })).toEqual({ detail: "invalid_input", trusted: false });
    expect(check({ origin: "not-a-url" })).toMatchObject({ trusted: false });
    // 空 pluginId 不再是拒绝理由，但空 origin 是
    expect(check({ origin: ZCODE_ORIGIN, pluginId: "" })).toMatchObject({ trusted: true });
  });

  describe("dev loopback switch", () => {
    it("accepts a loopback origin listed in the switch", () => {
      expect(
        check({ devTrustedOriginsRaw: "http://127.0.0.1:3999", origin: "http://127.0.0.1:3999" }),
      ).toEqual({ detail: "ok", trusted: true });
    });

    it("only opens loopback, never a remote origin", () => {
      // 关键：dev 开关不得成为"一个环境变量把 JWT 导向任意站点"的通道
      for (const entry of ["https://attacker.example", "http://evil.example"]) {
        expect(check({ devTrustedOriginsRaw: entry, origin: entry })).toMatchObject({
          trusted: false,
        });
      }
    });

    it("supports several comma-separated entries and ignores blanks", () => {
      const raw = " http://127.0.0.1:3999 , ,http://localhost:4010 ";
      expect(check({ devTrustedOriginsRaw: raw, origin: "http://localhost:4010" })).toMatchObject({
        trusted: true,
      });
      expect(check({ devTrustedOriginsRaw: raw, origin: "http://127.0.0.1:5000" })).toMatchObject({
        trusted: false,
      });
    });

    it("does not require an official plugin for loopback self-testing", () => {
      // 本地 plugin 经 dirs 加载时 marketplace 是 inline，自测必须仍可用
      expect(
        check({
          devTrustedOriginsRaw: "http://127.0.0.1:3999",
          origin: "http://127.0.0.1:3999",
          pluginId: "dev-official-mcp@inline",
        }),
      ).toMatchObject({ trusted: true });
    });

    it("changes nothing when the switch is absent", () => {
      expect(check({ origin: "http://127.0.0.1:3999" })).toMatchObject({ trusted: false });
    });

    it("still rejects a loopback origin that is not listed", () => {
      // 移除 marketplace 检查后，loopback 也必须逐条登记才放行，不能因 http loopback 就通过
      expect(
        check({ devTrustedOriginsRaw: "http://127.0.0.1:3999", origin: "http://127.0.0.1:9999" }),
      ).toMatchObject({ trusted: false });
    });
  });
});

describe("createOfficialMcpTrustedOriginRegistry", () => {
  it("resolves the ZCode API origin per call, so environment switches are picked up", async () => {
    let origin = ZCODE_ORIGIN;
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => origin,
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });

    // 切到 test 环境域名后，旧 origin 立即不再可信
    origin = "https://zcode-test.z.ai";
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: false });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: "https://zcode-test.z.ai",
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });
  });

  it("fails closed when the origin resolver throws", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => {
        throw new Error("settings unavailable");
      },
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toEqual({ detail: "zcode_origin_unresolved", trusted: false });
  });

  it("awaits an async origin resolver", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: async () => ZCODE_ORIGIN,
    });
    await expect(
      registry.isTrusted({
        mcpKey: "image-search",
        origin: ZCODE_ORIGIN,
        pluginId: OFFICIAL_PLUGIN,
      }),
    ).resolves.toMatchObject({ trusted: true });
  });

  it("ignores mcpKey entirely (no per-key allowlist any more)", async () => {
    const registry = createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => ZCODE_ORIGIN,
    });
    for (const mcpKey of ["image-search", "brand-new-mcp", ""]) {
      await expect(
        registry.isTrusted({ mcpKey, origin: ZCODE_ORIGIN, pluginId: OFFICIAL_PLUGIN }),
      ).resolves.toMatchObject({ trusted: true });
    }
  });
});
