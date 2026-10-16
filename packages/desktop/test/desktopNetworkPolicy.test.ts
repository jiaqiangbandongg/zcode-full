import forge from "node-forge";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  applyDesktopChromiumNetworkPolicies,
  applyDesktopSessionNetworkPolicy,
  buildElectronProxyConfig,
  certificateChainMatchesCustomCa,
  createCustomCaCertificateVerifyProc,
  readCustomCaFingerprintsFromPem,
} from "../src/main/desktopNetworkPolicy.js";
import { EMBEDDED_BROWSER_PARTITION } from "../src/main/browserDataManager.js";

describe("desktopNetworkPolicy", () => {
  it("applies the startup network policy only to the default and embedded Browser sessions", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const codingPlanSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn((partition: string) =>
        partition === EMBEDDED_BROWSER_PARTITION
          ? embeddedBrowserSession.session
          : codingPlanSession.session,
      ),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      {
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "localhost,127.0.0.1",
      },
      logger,
    );

    expect(sessionProvider.fromPartition).toHaveBeenCalledTimes(1);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(EMBEDDED_BROWSER_PARTITION);
    for (const target of [defaultSession, embeddedBrowserSession]) {
      expect(target.setProxy).toHaveBeenCalledWith({
        mode: "fixed_servers",
        proxyBypassRules: "localhost,127.0.0.1",
        proxyRules: "http://127.0.0.1:7890",
      });
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(target.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    }
    expect(codingPlanSession.setProxy).not.toHaveBeenCalled();
  });

  it("falls back to the system proxy only on the embedded Browser session when the setting is empty", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger);

    // Bug 原因：留空曾被翻译成 `direct`，而 Electron 的 `direct` 是「永不使用代理」，
    // 会连本机系统代理一起屏蔽。内置浏览器是用户的浏览出口，需要代理才能访问的站点
    // 会直接 ERR_CONNECTION_TIMED_OUT，与用户本机浏览器行为漂移。
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    // defaultSession 承载 ZCode 自身的后端与模型流量，留空时保持显式收敛，不受系统代理影响。
    expect(defaultSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
  });

  it("continues configuring the embedded Browser session when the default session fails", async () => {
    const defaultError = new Error("default session proxy failed");
    const defaultSession = createSessionStub({ setProxyError: defaultError });
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger);

    expect(defaultSession.closeAllConnections).not.toHaveBeenCalled();
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(embeddedBrowserSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(embeddedBrowserSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-network] default-session network policy apply failed:",
      defaultError,
    );
  });

  it("accepts every certificate on the embedded Browser session when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    const embeddedProc = embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(embeddedProc).toBeTypeOf("function");
    const results: number[] = [];
    embeddedProc?.(
      buildVerifyRequest(generateSelfSignedCertPem("Untrusted Intranet")),
      (result: number) => results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("keeps the default session on strict verification when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    // 放行只属于内置浏览器出口；defaultSession 承载 ZCode 自身的后端与模型流量，必须保持严格校验。
    expect(defaultSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  it("keeps every session on strict verification when insecure certificates are disabled", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: false },
      logger,
    );

    expect(defaultSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(embeddedBrowserSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  it("prefers blanket acceptance over the custom CA chain check when both are configured", async () => {
    const targetSession = createSessionStub();
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopSessionNetworkPolicy(
      targetSession.session,
      { httpProxyCaCertPath: "/definitely/missing/root-ca.pem" },
      logger,
      { allowInsecureCertificates: true },
    );

    const proc = targetSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(proc).toBeTypeOf("function");
    const results: number[] = [];
    proc?.(buildVerifyRequest(generateSelfSignedCertPem("Intranet")), (result: number) =>
      results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("builds a fixed-server proxy config from the explicit setting", () => {
    expect(
      buildElectronProxyConfig(
        "127.0.0.1:7890",
        " localhost, 127.0.0.1 ,.example.com ",
      ),
    ).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,.example.com",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("uses direct mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ")).toEqual({ mode: "direct" });
  });

  it("falls back to the requested mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ", "localhost", "system")).toEqual({ mode: "system" });
  });

  it("keeps the explicit proxy config regardless of the fallback mode", () => {
    // 兜底模式只在留空时生效；显式代理仍必须原样落到 fixed_servers，避免设置页配置被系统代理顶掉。
    expect(buildElectronProxyConfig("127.0.0.1:7890", "localhost", "system")).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("applies proxy config and resets renderer certificate policy from settings", async () => {
    const targetSession = {
      setProxy: vi.fn(() => Promise.resolve()),
      closeAllConnections: vi.fn(() => Promise.resolve()),
      setCertificateVerifyProc: vi.fn(),
    } as unknown as Session;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopSessionNetworkPolicy(
      targetSession,
      {
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "localhost,127.0.0.1",
      },
      logger,
    );

    expect(targetSession.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1",
      proxyRules: "http://127.0.0.1:7890",
    });
    expect(targetSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(targetSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  it("accepts only certificate chains that include the configured custom CA", () => {
    const trustedPem = generateSelfSignedCertPem("Trusted Test CA");
    const untrustedPem = generateSelfSignedCertPem("Other Test CA");
    const trustedFingerprints = readCustomCaFingerprintsFromPem(trustedPem);
    const proc = createCustomCaCertificateVerifyProc(trustedFingerprints);
    const acceptedResults: number[] = [];
    const rejectedResults: number[] = [];

    expect(proc).not.toBeNull();
    expect(
      certificateChainMatchesCustomCa(
        { data: trustedPem, issuerCert: null },
        trustedFingerprints,
      ),
    ).toBe(true);
    expect(
      certificateChainMatchesCustomCa(
        { data: untrustedPem, issuerCert: null },
        trustedFingerprints,
      ),
    ).toBe(false);

    proc?.(buildVerifyRequest(trustedPem), (result) => acceptedResults.push(result));
    proc?.(buildVerifyRequest(untrustedPem), (result) => rejectedResults.push(result));

    expect(acceptedResults).toEqual([0]);
    expect(rejectedResults).toEqual([-3]);
  });
});

function createSessionStub(options: { setProxyError?: Error } = {}) {
  const setProxy = vi.fn(async () => {
    if (options.setProxyError) throw options.setProxyError;
  });
  const closeAllConnections = vi.fn(async () => {});
  const setCertificateVerifyProc = vi.fn();
  return {
    session: {
      setProxy,
      closeAllConnections,
      setCertificateVerifyProc,
    } as unknown as Session,
    setProxy,
    closeAllConnections,
    setCertificateVerifyProc,
  };
}

type VerifyRequest = Parameters<
  NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>
>[0];

/** 构造一条「Chromium 已判定证书不受信」的校验请求，用于驱动 verifyProc 的拒绝分支。 */
function buildVerifyRequest(certPem: string): VerifyRequest {
  return {
    certificate: { data: certPem, issuerCert: null },
    hostname: "intranet.test",
    isIssuedByKnownRoot: false,
    validatedCertificate: { data: certPem, issuerCert: null },
    verificationResult: "CERT_AUTHORITY_INVALID",
    errorCode: -202,
  } as unknown as VerifyRequest;
}

function generateSelfSignedCertPem(commonName: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}
