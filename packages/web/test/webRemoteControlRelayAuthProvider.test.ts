import { describe, expect, it } from "vitest";
import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { calculateBrowserWebRemoteControlProof } from "../src/webRemoteControlRelayAuthProvider.js";

describe("calculateBrowserWebRemoteControlProof", () => {
  it("matches the external relay HMAC proof vectors", async () => {
    for (const vector of WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS) {
      await expect(
        calculateBrowserWebRemoteControlProof(
          vector.passHash,
          vector.nonce,
          vector.role,
          vector.deviceSid,
        ),
      ).resolves.toBe(vector.proof);
    }
  });
});
