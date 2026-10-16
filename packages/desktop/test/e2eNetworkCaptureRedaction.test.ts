import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import {
  E2E_NETWORK_CAPTURE_REDACTION_VALUE,
  redactE2ENetworkCaptureJson,
  redactE2ENetworkCaptureJsonText,
  sanitizeE2ENetworkCaptureHeaders,
  shouldRecordE2ENetworkResponseChunkTimeline
} from "./e2e/helpers/e2e-network-capture-redaction.js";
import { removeUnusableE2ENetworkCaptureLeafCertificates } from "./e2e/helpers/network-capture-proxy.js";

describe("E2E network capture redaction", () => {
  it("redacts API credentials", () => {
    expect(
      sanitizeE2ENetworkCaptureHeaders({
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-api-key": "user-api-key",
        "x-session-id": "session-safe-to-record"
      })
    ).toEqual({
      authorization: E2E_NETWORK_CAPTURE_REDACTION_VALUE,
      "content-type": "application/json",
      "x-api-key": E2E_NETWORK_CAPTURE_REDACTION_VALUE,
      "x-session-id": "session-safe-to-record"
    });
  });

  it("redacts handshake secrets recursively without hiding business fields", () => {
    expect(
      redactE2ENetworkCaptureJson({
        code: 200,
        data: {
          keyCipher: "encrypted-pkcs8",
          provider: "stagingModel"
        },
        request: {
          apiKey: "user-api-key",
          sig: "handshake-signature"
        }
      })
    ).toEqual({
      code: 200,
      data: {
        keyCipher: E2E_NETWORK_CAPTURE_REDACTION_VALUE,
        provider: "stagingModel"
      },
      request: {
        apiKey: E2E_NETWORK_CAPTURE_REDACTION_VALUE,
        sig: E2E_NETWORK_CAPTURE_REDACTION_VALUE
      }
    });
  });

  it("redacts a JSON response preview before the artifact is serialized", () => {
    const preview = redactE2ENetworkCaptureJsonText(
      JSON.stringify({
        code: 200,
        data: { keyCipher: "encrypted-pkcs8" }
      })
    );

    expect(JSON.parse(preview)).toEqual({
      code: 200,
      data: { keyCipher: E2E_NETWORK_CAPTURE_REDACTION_VALUE }
    });
    expect(preview).not.toContain("encrypted-pkcs8");
  });

  it("records raw response chunks only for SSE streams", () => {
    expect(
      shouldRecordE2ENetworkResponseChunkTimeline(true, {
        "content-type": "application/json; charset=utf-8"
      })
    ).toBe(false);
    expect(
      shouldRecordE2ENetworkResponseChunkTimeline(true, {
        "content-type": "text/event-stream; charset=utf-8"
      })
    ).toBe(true);
    expect(
      shouldRecordE2ENetworkResponseChunkTimeline(false, {
        "content-type": "text/event-stream; charset=utf-8"
      })
    ).toBe(false);
  });

  it("removes expired or key-mismatched MITM leaf certificates before capture starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-e2e-network-cert-"));
    const certsDir = join(root, "certs");
    const keysDir = join(root, "keys");
    await mkdir(certsDir);
    await mkdir(keysDir);
    try {
      const expiredHost = "expired.example.test";
      const freshHost = "fresh.example.test";
      const mismatchedHost = "mismatched.example.test";
      const expired = createCertificate(expiredHost, new Date("2025-01-01T00:00:00Z"));
      const fresh = createCertificate(freshHost, new Date("2035-01-01T00:00:00Z"));
      const mismatched = createCertificate(mismatchedHost, new Date("2035-01-01T00:00:00Z"));
      await Promise.all([
        writeFile(join(certsDir, `${expiredHost}.pem`), expired.certificate),
        writeFile(join(certsDir, `${freshHost}.pem`), fresh.certificate),
        writeFile(join(certsDir, `${mismatchedHost}.pem`), mismatched.certificate),
        writeFile(join(certsDir, "ca.pem"), "root-ca"),
        writeFile(join(keysDir, `${expiredHost}.key`), expired.privateKey),
        writeFile(join(keysDir, `${expiredHost}.public.key`), "expired-public-key"),
        writeFile(join(keysDir, `${freshHost}.key`), fresh.privateKey),
        writeFile(join(keysDir, `${mismatchedHost}.key`), fresh.privateKey)
      ]);

      await removeUnusableE2ENetworkCaptureLeafCertificates(root, new Date("2030-01-01T00:00:00Z"));

      await expect(readFile(join(certsDir, `${expiredHost}.pem`))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(keysDir, `${expiredHost}.key`))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(keysDir, `${expiredHost}.public.key`))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(certsDir, `${mismatchedHost}.pem`))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(certsDir, `${freshHost}.pem`), "utf8")).resolves.toContain("BEGIN CERTIFICATE");
      await expect(readFile(join(certsDir, "ca.pem"), "utf8")).resolves.toBe("root-ca");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function createCertificate(commonName: string, notAfter: Date): { certificate: string; privateKey: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2024-01-01T00:00:00Z");
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: "commonName", value: commonName }]);
  certificate.setIssuer([{ name: "commonName", value: "ZCode E2E Test CA" }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificate: forge.pki.certificateToPem(certificate),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey)
  };
}
