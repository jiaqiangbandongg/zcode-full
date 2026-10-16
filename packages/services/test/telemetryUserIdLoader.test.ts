import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_DECRYPT_ERROR_CODE } from "@zcode/shared";
import { createTelemetryUserIdLoader } from "../src/node.js";
import type { ICredentialService } from "../src/credential/credential.js";

function createCredentialDecryptError(): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error("serialized credential decrypt failure"), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

describe("createTelemetryUserIdLoader", () => {
  it("keeps telemetry credential reads best effort when OAuth credentials cannot decrypt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deletedKeys: string[] = [];
    const credentialService: ICredentialService = {
      load: async (key) => {
        if (key === "oauth:active_provider") {
          throw createCredentialDecryptError();
        }
        return null;
      },
      save: async () => {},
      delete: async (key) => {
        deletedKeys.push(key);
      },
    };

    await expect(createTelemetryUserIdLoader(credentialService)()).resolves.toBe("");

    expect(deletedKeys).toEqual([]);
  });
});
