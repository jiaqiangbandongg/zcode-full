import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAppCaCert, getAppCaCertPaths } from "../src/runtime-tools/appCaCert.js";
import { setDataBaseDir } from "../src/paths.js";

describe("ensureAppCaCert", () => {
  afterEach(() => {
    setDataBaseDir(null);
  });

  it("generates a self-signed CA certificate and private key on first run", () => {
    setDataBaseDir(mkdtempSync(join(tmpdir(), "zcode-ca-")));
    const certPath = ensureAppCaCert();
    const { keyPath } = getAppCaCertPaths();

    const cert = new X509Certificate(readFileSync(certPath));
    expect(cert.subject).toContain("ZCode Network CA");
    // 自签：issuer == subject
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.ca).toBe(true);

    const keyPem = readFileSync(keyPath, "utf8");
    expect(keyPem).toContain("PRIVATE KEY");
    // 私钥权限收紧（POSIX）
    if (process.platform !== "win32") {
      expect(statSync(keyPath).mode & 0o077).toBe(0);
    }
  });

  it("is idempotent: reuses the existing certificate", () => {
    setDataBaseDir(mkdtempSync(join(tmpdir(), "zcode-ca-")));
    const certPath = ensureAppCaCert();
    const firstPem = readFileSync(certPath, "utf8");
    const secondPath = ensureAppCaCert();
    expect(secondPath).toBe(certPath);
    expect(readFileSync(secondPath, "utf8")).toBe(firstPem);
  });
});
