import { describe, expect, it, vi } from "vitest";
import { persistPersonalProviderDeletion } from "@/lib/providerPersonalPersistence.js";

describe("persistPersonalProviderDeletion", () => {
  it("有 Settings Service 时只删除 Personal Config", async () => {
    const calls: string[] = [];

    await persistPersonalProviderDeletion({
      providerId: "personal-api",
      providerSettingsService: {
        deletePersonalProvider: vi.fn(async () => {
          calls.push("personal");
          return { revision: 2, providers: [] };
        }),
      },
    });

    expect(calls).toEqual(["personal"]);
  });
});
