import { describe, expect, it, vi } from "vitest";
import { createAccountProviderCredentialStore } from "../src/model-provider/accountProviderCredentialStore.js";

function createCredentialService(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    load: vi.fn(async (key: string) => values.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

describe("AccountProviderCredentialStore", () => {
  const credentialKey =
    "account-provider:coding-plan:account:zai-individual-coding-plan:account:user-a:api-key";

  it("按私有 Credential Key 读取当前凭据", async () => {
    const credentialService = createCredentialService({ [credentialKey]: "current-key" });
    const store = createAccountProviderCredentialStore({ credentialService });

    await expect(store.loadApiKey(credentialKey)).resolves.toBe("current-key");
  });

  it("新凭据缺失时不再从旧 Provider Store 迁移 Key", async () => {
    const credentialService = createCredentialService();
    const store = createAccountProviderCredentialStore({ credentialService });

    await expect(store.loadApiKey(credentialKey)).resolves.toBeNull();
    expect(credentialService.save).not.toHaveBeenCalled();
  });

  it("空旧值不写入凭据，保存空值等价于删除", async () => {
    const credentialService = createCredentialService();
    const store = createAccountProviderCredentialStore({ credentialService });

    await expect(store.loadApiKey(credentialKey)).resolves.toBeNull();
    expect(credentialService.save).not.toHaveBeenCalled();

    await store.saveApiKey(credentialKey, "new-key");
    await store.saveApiKey(credentialKey, "  ");

    expect(credentialService.delete).toHaveBeenCalledWith(credentialKey);
    await expect(store.loadApiKey(credentialKey)).resolves.toBeNull();
  });

  it("拒绝空 Credential Key", async () => {
    const store = createAccountProviderCredentialStore({
      credentialService: createCredentialService(),
    });

    await expect(store.loadApiKey(" ")).rejects.toThrow("Credential Key");
    await expect(store.saveApiKey(" ", "key")).rejects.toThrow("Credential Key");
    await expect(store.deleteApiKey(" ")).rejects.toThrow("Credential Key");
  });
});
