import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProxyConfig, Session } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";

interface DesktopNetworkPolicySettings {
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
}

/**
 * 设置页代理留空时的兜底模式。
 *
 * `direct` 是 Electron 的「永不使用代理」，会连本机系统代理一起屏蔽；
 * `system` 读取的是 OS 网络设置（macOS 网络偏好 / Windows Internet 选项），
 * 与 shell 里的 `HTTP_PROXY` 等环境变量无关，因此不违反「不继承 shell 环境变量」的边界。
 */
type ProxyFallbackMode = "direct" | "system";

interface DesktopSessionNetworkPolicyOptions {
  /** 是否放行该 Session 的全部证书错误。仅内置浏览器出口可以打开。 */
  allowInsecureCertificates?: boolean;
  /** 设置页代理留空时使用的兜底模式，默认 `direct`。 */
  fallbackProxyMode?: ProxyFallbackMode;
}

interface DesktopNetworkPolicyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface DesktopSessionProvider {
  readonly defaultSession: Session;
  fromPartition(partition: string): Session;
}

type CertificateVerifyProc = NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>;

interface CertificateLike {
  data?: string;
  fingerprint?: string;
  issuerCert?: CertificateLike | null;
}

const USE_CHROMIUM_DEFAULT_VERIFICATION = -3;
const ACCEPT_CERTIFICATE = 0;
const MAX_CERTIFICATE_CHAIN_DEPTH = 16;

export async function applyDesktopChromiumNetworkPolicies(
  sessionProvider: DesktopSessionProvider,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
): Promise<void> {
  const targets = [
    {
      name: "default-session",
      session: sessionProvider.defaultSession,
      allowInsecure: false,
      // ZCode 自身对后端与模型 API 的出口，收敛到设置页的显式配置，不被本机系统代理左右。
      fallbackProxyMode: "direct" as const,
    },
    {
      name: "embedded-browser",
      session: sessionProvider.fromPartition(EMBEDDED_BROWSER_PARTITION),
      // 自签名放行只开在内置浏览器出口：defaultSession 承载 renderer 对 ZCode 后端与模型 API
      // 的流量，在那里放行等于整个应用失去 TLS 保护，与「访问内网测试站点」的诉求不成比例。
      allowInsecure: settings.embeddedBrowserAllowInsecureCertificates === true,
      // 内置浏览器是用户自己的浏览出口，留空时跟随系统代理，与本机浏览器保持一致；
      // 否则需要代理才能访问的站点只会拿到 ERR_CONNECTION_TIMED_OUT，用户无从下手。
      fallbackProxyMode: "system" as const,
    },
  ] as const;

  await Promise.all(
    targets.map(async (target) => {
      try {
        await applyDesktopSessionNetworkPolicy(target.session, settings, logger, {
          allowInsecureCertificates: target.allowInsecure,
          fallbackProxyMode: target.fallbackProxyMode,
        });
      } catch (error) {
        // 内置 Browser 使用独立 partition，过去只配置 defaultSession；同时
        // 单一 Session 的启动失败不能阻断另一个出口，否则 renderer 与 Browser 会再次漂移。
        logger.warn(`[desktop-network] ${target.name} network policy apply failed:`, error);
      }
    }),
  );
}

export async function applyDesktopSessionNetworkPolicy(
  targetSession: Session,
  settings: DesktopNetworkPolicySettings,
  logger: DesktopNetworkPolicyLogger,
  options: DesktopSessionNetworkPolicyOptions = {},
): Promise<void> {
  const proxyConfig = buildElectronProxyConfig(
    settings.httpProxy,
    settings.httpProxyNoProxy,
    options.fallbackProxyMode,
  );
  await targetSession.setProxy(proxyConfig);
  await targetSession.closeAllConnections();

  // 全放行比自定义 CA 更宽松，两者同时配置时按前者生效，避免出现「开了开关仍被拒」的困惑。
  const verifyProc = options.allowInsecureCertificates
    ? createInsecureCertificateVerifyProc()
    : createCustomCaCertificateVerifyProcFromFile(settings.httpProxyCaCertPath, logger);
  targetSession.setCertificateVerifyProc(verifyProc);

  const bypassState = proxyConfig.proxyBypassRules ? "enabled" : "disabled";
  const customCaState = verifyProc ? "enabled" : "disabled";
  logger.info(
    `[desktop-network] renderer proxy mode=${proxyConfig.mode ?? "fixed_servers"} bypass=${bypassState} customCa=${customCaState} insecureCerts=${options.allowInsecureCertificates ? "allowed" : "rejected"}`,
  );
}

/**
 * 放行全部证书错误的校验过程。
 *
 * 仅供内置浏览器 partition 使用：自签名证书的内网测试站点在 Electron `<webview>` 里
 * 拿不到 Chrome 的安全插页，被拒后只剩一张空的 chrome-error 页，用户无从放行。
 */
export function createInsecureCertificateVerifyProc(): CertificateVerifyProc {
  return (_request, callback) => {
    callback(ACCEPT_CERTIFICATE);
  };
}

export function buildElectronProxyConfig(
  httpProxy: string | undefined,
  noProxy?: string | undefined,
  fallbackMode: ProxyFallbackMode = "direct",
): ProxyConfig {
  const proxyRules = normalizeProxyRules(httpProxy);
  if (!proxyRules) {
    // 留空不带 proxyBypassRules：bypass 规则只对 fixed_servers 有意义，
    // `system` 模式下的例外列表由 OS 自己维护（如 macOS 的「忽略这些主机」）。
    return { mode: fallbackMode };
  }
  const proxyConfig: ProxyConfig = {
    mode: "fixed_servers",
    proxyRules,
  };
  const proxyBypassRules = normalizeProxyBypassRules(noProxy);
  if (proxyBypassRules) {
    proxyConfig.proxyBypassRules = proxyBypassRules;
  }
  return proxyConfig;
}

export function createCustomCaCertificateVerifyProcFromFile(
  caCertPath: string | undefined,
  logger: Pick<DesktopNetworkPolicyLogger, "warn">,
): CertificateVerifyProc | null {
  const trimmed = caCertPath?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const trustedFingerprints = readCustomCaFingerprintsFromPem(
      readFileSync(trimmed, "utf8"),
    );
    if (trustedFingerprints.size === 0) {
      logger.warn(`[desktop-network] custom CA file contains no certificates: ${trimmed}`);
      return null;
    }
    return createCustomCaCertificateVerifyProc(trustedFingerprints);
  } catch (error) {
    logger.warn(`[desktop-network] failed to load custom CA file: ${trimmed}`, error);
    return null;
  }
}

export function createCustomCaCertificateVerifyProc(
  trustedFingerprints: ReadonlySet<string>,
): CertificateVerifyProc | null {
  if (trustedFingerprints.size === 0) {
    return null;
  }

  return (request, callback) => {
    if (request.verificationResult === "OK") {
      callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
      return;
    }

    if (
      certificateChainMatchesCustomCa(request.certificate, trustedFingerprints) ||
      certificateChainMatchesCustomCa(request.validatedCertificate, trustedFingerprints)
    ) {
      // renderer 的 Chromium 网络栈不会读取 NODE_EXTRA_CA_CERTS。
      // 自定义 CA 只能从设置页显式路径进入这里，命中链路后才放行，避免把所有证书错误都绕过。
      callback(ACCEPT_CERTIFICATE);
      return;
    }

    callback(USE_CHROMIUM_DEFAULT_VERIFICATION);
  };
}

export function readCustomCaFingerprintsFromPem(pem: string): Set<string> {
  const fingerprints = new Set<string>();
  const certBlocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];

  for (const block of certBlocks) {
    fingerprints.add(normalizeFingerprint(new X509Certificate(block).fingerprint256));
  }
  return fingerprints;
}

export function certificateChainMatchesCustomCa(
  certificate: CertificateLike,
  trustedFingerprints: ReadonlySet<string>,
): boolean {
  let current: CertificateLike | null | undefined = certificate;
  const seen = new Set<string>();

  for (let depth = 0; current && depth < MAX_CERTIFICATE_CHAIN_DEPTH; depth += 1) {
    const fingerprint = readCertificateFingerprint(current);
    if (fingerprint) {
      if (trustedFingerprints.has(fingerprint)) {
        return true;
      }
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
    }
    current = current.issuerCert;
  }
  return false;
}

function normalizeProxyRules(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    const auth = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    return `${url.protocol}//${auth}${url.host}`;
  } catch {
    return undefined;
  }
}

function normalizeProxyBypassRules(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}

function readCertificateFingerprint(certificate: CertificateLike): string | undefined {
  if (certificate.data) {
    try {
      return normalizeFingerprint(new X509Certificate(certificate.data).fingerprint256);
    } catch {
      // Electron 也提供 fingerprint 字段；PEM 解析失败时退回该字段做兼容。
    }
  }
  return certificate.fingerprint ? normalizeFingerprint(certificate.fingerprint) : undefined;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, "").toLowerCase();
}
