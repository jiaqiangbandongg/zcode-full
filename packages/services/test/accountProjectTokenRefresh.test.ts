import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountProjectTokenClient } from "../src/model-provider/accountProjectTokenClient.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

afterEach(() => vi.useRealTimers());

describe("Desktop PAT 临时故障分类", () => {
  it.each(["network", "timeout", 429, 503, 401, 403, 404, "invalid", "unknown"])(
    "%s 只在允许范围内复用未过期 PAT",
    async (failure) => {
      vi.useFakeTimers();
      const start = Date.now();
      let issues = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        let data: unknown;
        if (url.endsWith("getCustomerInfo"))
          data = {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          };
        else if (url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
        else {
          issues++;
          if (issues > 1) {
            if (failure === "network") throw new TypeError("fetch failed: secret must not escape");
            if (failure === "timeout") throw new DOMException("timeout", "AbortError");
            if (failure === "unknown") throw new Error("unknown secret");
            if (failure === "invalid") return new Response("invalid secret JSON");
            return new Response("upstream secret", { status: failure });
          }
          data = {
            accessToken: "old-pat",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: start / 1000 + 600,
          };
        }
        return Response.json({ code: "0", data });
      });
      const values = new Map<string, string>();
      const client = createAccountProjectTokenClient(createNodeApiClient({ fetchImpl }), {
        load: async (key) => values.get(key) ?? null,
        save: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      });
      const input = {
        family: "bigmodel" as const,
        origin: "https://example.invalid",
        accountId: "user",
        loginToken: "login",
      };
      await expect(client.resolve(input)).resolves.toMatchObject({ token: "old-pat" });
      vi.setSystemTime(start + 481_000);
      if (["network", "timeout", 429, 503].includes(failure)) {
        const results = await Promise.all([client.resolve(input), client.resolve(input)]);
        expect(results.map((value) => value.token)).toEqual(["old-pat", "old-pat"]);
        await client.resolve(input);
        expect(issues).toBe(2);
        vi.setSystemTime(start + 600_000);
      }
      await expect(client.resolve(input)).rejects.toThrow(
        /^project_token_(request_failed|invalid_response)$/,
      );
      expect(JSON.stringify([...values])).not.toMatch(/old-pat|login/);
    },
  );
});
