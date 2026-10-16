import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import {
  listProviderProvisioningCredentialKeys,
  createProviderProvisioningSource,
} from "../src/model-provider/providerProvisioningSource.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function personalRepository(root: string) {
  const repo = new NodePersonalProviderConfigRepository({
    filePath: join(root, "provider_config.json"),
    pollingIntervalMs: false,
  });
  cleanups.push(async () => {
    repo.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return repo;
}

describe("Provider Provisioning Source", () => {
  it("exports sparse Personal Config, default, account settings and only provider credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-provisioning-source-"));
    const credentialsPath = join(root, "credentials.json");
    const cipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "source" } });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        "oauth:active_provider": cipher.encrypt("zai"),
        "oauth:zai:access_token": cipher.encrypt("oauth-token"),
        "account-provider:individual-coding-plan:provider:account:user:api-key":
          cipher.encrypt("coding-plan-key"),
        "account-provider:custom-provider:identity": cipher.encrypt("account-user-id"),
        "ssh:password": cipher.encrypt("must-not-export"),
        "ssh:malformed": { unexpected: true },
        "account-provider:coding-plan:legacy:account:user:api-key": "enc:v1:broken",
        "account-provider:coding-plan:malformed:account:user:api-key": { invalid: true },
      }),
      "utf8",
    );
    const repository = personalRepository(root);
    await repository.update(() => ({
      providers: parsePersonalProviderConfigMap({
        providerRules: [
          {
            providerId: "custom",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "provider-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              personalModelIds: ["model-a"],
            },
          },
        ],
      }),
      models: ModelConfigRules.empty(),
      providerOrder: ["custom"],
      defaultModelSelection: { providerId: "custom", modelId: "model-a" },
    }));
    const source = createProviderProvisioningSource({
      personalRepository: repository,
      settingService: {
        get: vi.fn(async () => ({
          providerFamilyDomain: "zai",
          providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
        })),
      } as never,
      credentialFilePath: credentialsPath,
      personalConfigFilePath: join(root, "provider_config.json"),
      cipherProvider: cipher,
    });

    const snapshot = await source.read("sync-source");
    expect(await listProviderProvisioningCredentialKeys(credentialsPath)).toEqual([
      "oauth:active_provider",
      "oauth:zai:access_token",
    ]);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.personalConfig).toEqual(
      encodeProviderConfigFile(await repository.read()).config,
    );
    expect(snapshot.personalConfig.defaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(snapshot.credentials).toEqual([
      { scope: "oauth-session", key: "oauth:active_provider", value: "zai" },
      { scope: "oauth-session", key: "oauth:zai:access_token", value: "oauth-token" },
    ]);
    expect(snapshot.credentials.some((entry) => entry.key === "ssh:password")).toBe(false);
    expect(snapshot.credentials.some((entry) => entry.key.endsWith(":identity"))).toBe(false);
    expect(snapshot).not.toHaveProperty("sourceRevision");
    repository.dispose();
  });

  it("does not let malformed non-allowlist credential records block sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-provisioning-source-"));
    const credentialsPath = join(root, "credentials.json");
    const cipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "source" } });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        "oauth:active_provider": cipher.encrypt("zai"),
        "ssh:malformed": { unexpected: true },
        "account-provider:coding-plan:legacy:account:user:api-key": "enc:v1:broken",
        "account-provider:coding-plan:malformed:account:user:api-key": { invalid: true },
      }),
      "utf8",
    );
    const source = createProviderProvisioningSource({
      personalRepository: personalRepository(root),
      settingService: { get: vi.fn(async () => ({})) } as never,
      credentialFilePath: credentialsPath,
      personalConfigFilePath: join(root, "provider_config.json"),
      cipherProvider: cipher,
    });

    await expect(source.read("sync-malformed-unrelated")).resolves.toMatchObject({
      credentials: [{ scope: "oauth-session", key: "oauth:active_provider", value: "zai" }],
    });
  });

  it("still rejects malformed allowlist credential records", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-provisioning-source-"));
    const credentialsPath = join(root, "credentials.json");
    await writeFile(
      credentialsPath,
      JSON.stringify({ "oauth:active_provider": { malformed: true } }),
      "utf8",
    );
    const source = createProviderProvisioningSource({
      personalRepository: personalRepository(root),
      settingService: { get: vi.fn(async () => ({})) } as never,
      credentialFilePath: credentialsPath,
      personalConfigFilePath: join(root, "provider_config.json"),
    });

    await expect(source.read("sync-malformed-allowlist")).rejects.toThrow(
      "Credential allowlist value must be a string",
    );
  });
});
