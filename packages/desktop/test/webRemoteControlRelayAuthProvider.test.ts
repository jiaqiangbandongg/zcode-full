import { describe, expect, it } from "vitest";
import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { createNodeWebRemoteControlRelayAuthProvider } from "../src/main/webRemoteControlRelayAuthProvider.js";

describe("createNodeWebRemoteControlRelayAuthProvider", () => {
  it("matches the external relay HMAC proof vectors", () => {
    const provider = createNodeWebRemoteControlRelayAuthProvider();

    for (const vector of WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS) {
      expect(
        provider.calculateProof(
          vector.passHash,
          vector.nonce,
          vector.role,
          vector.deviceSid,
        ),
      ).toBe(vector.proof);
    }
  });

  it("creates a base64 sha256 pass hash", () => {
    const provider = createNodeWebRemoteControlRelayAuthProvider();

    expect(provider.createPassHash("password")).toBe("XohImNooBHFR0OVvjcYpJ3NgPQ1qq73WKhHvch0VQtg=");
  });
});
