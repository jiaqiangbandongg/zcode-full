// 下载并整理 GLM 平台二进制。
//
// 开发态优先走 ZCODE_AGENT_WORKDIR / 同级仓库源码启动；只有打包态、生产态和无源码的开发环境
// 才需要依赖这个脚本提前准备平台二进制。目录布局统一服务本机打包与远程部署：
// - 当前目标平台输出到 bundled-agents，供本机运行 / 打包直接内置
// - 远程专用平台输出到 mock-cdn，供 remote deploy 按平台拉取

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..");

function readZCodeAgentRuntimeVersion() {
  const runtimeSourcePath = path.join(REPO_ROOT, "packages/shared/src/zcode-agent-runtime.ts");
  const runtimeSource = fs.readFileSync(runtimeSourcePath, "utf8");
  const match = runtimeSource.match(/version:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error("Unable to parse ZCode Agent runtime version");
  }
  return match[1];
}

export const GLM_RUNTIME_VERSION = readZCodeAgentRuntimeVersion();
// Bugfix: GLM 二进制按 zcode-cli 版本发布，旧的 deps/zcode-cli 会在版本升级后复用旧目录。
// 这里读取 shared runtime 里的 glm.version，让下载目录与远程 manifest/cache 版本来源一致。
function resolveDefaultGlmBinaryDownloadBaseUrl(env = process.env) {
  return `${resolveIntranetDepsBaseUrl(env)}/zcode-cli-${GLM_RUNTIME_VERSION}`;
}

function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

function detectPlatform() {
  const s =
    process.platform === "win32" ? "win32" : execSync("uname -s").toString().trim().toLowerCase();
  return normalizePlatform(s);
}

function detectArch() {
  const m =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : execSync("uname -m").toString().trim();
  return normalizeArch(m);
}

export function resolveGlmDownloadName(platform, arch) {
  // Bugfix：Windows 产物命名恢复为 zcode-windows-*.exe，避免继续请求到错误文件名。
  if (platform === "win32") {
    return `zcode-windows-${arch}.exe`;
  }

  return `zcode-${platform}-${arch}`;
}

export function resolveGlmDownloadBaseUrl(env = process.env) {
  return env.GLM_BINARY_DOWNLOAD_BASE_URL || resolveDefaultGlmBinaryDownloadBaseUrl(env);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null;
}

export function isGlmBundleMetaMatch(meta, expected) {
  if (!isPlainObject(meta)) {
    return false;
  }

  const provider = typeof meta.provider === "string" ? meta.provider : null;
  const version = typeof meta.version === "string" ? meta.version : null;
  const platform = typeof meta.platform === "string" ? meta.platform : null;
  const source = typeof meta.source === "string" ? meta.source : null;

  return (
    provider === "glm" &&
    version === expected.version &&
    platform === expected.platform &&
    source === expected.source
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // Bugfix: 历史下载中断或手工改动可能留下损坏 meta。
    // 解析失败时不命中缓存，后续按当前 GLM 版本重新下载并重写 meta。
    return null;
  }
}

function writeGlmBundleMeta(outputDir, expectedMeta) {
  const metadata = JSON.stringify(
    {
      provider: "glm",
      version: expectedMeta.version,
      platform: expectedMeta.platform,
      source: expectedMeta.source,
    },
    null,
    2,
  );
  fs.writeFileSync(path.join(outputDir, ".bundle-meta.json"), `${metadata}\n`, "utf8");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

export async function main() {
  const platform =
    normalizePlatform(process.argv[2] || process.env.ZCODE_TARGET_OS || "") || detectPlatform();
  const arch =
    normalizeArch(process.argv[3] || process.env.ZCODE_TARGET_ARCH || "") || detectArch();
  const forceRemoteOutput = process.env.ZCODE_FORCE_REMOTE_MOCK_CDN === "1";

  const localPlatform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || detectPlatform();
  const localArch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || detectArch();

  const platformKey = `${platform}-${arch}`;
  const localKey = `${localPlatform}-${localArch}`;

  const repoRoot = REPO_ROOT;

  const localOutputDir = path.join(repoRoot, "packages/desktop/bundled-agents", platformKey, "glm");
  const version = require(path.join(repoRoot, "package.json")).version;
  const remoteOutputDir = path.join(
    repoRoot,
    "packages/desktop/mock-cdn/releases",
    version,
    "glm",
    platformKey,
  );
  const outputDir = forceRemoteOutput
    ? remoteOutputDir
    : platformKey === localKey
      ? localOutputDir
      : remoteOutputDir;

  const binaryName = platform === "win32" ? "zcode-agent.exe" : "zcode-agent";
  const binaryPath = path.join(outputDir, binaryName);

  const baseUrl = resolveGlmDownloadBaseUrl();
  const downloadUrl = `${baseUrl}/${resolveGlmDownloadName(platform, arch)}`;
  const expectedMeta = {
    version: GLM_RUNTIME_VERSION,
    platform: platformKey,
    source: downloadUrl,
  };
  const metadataPath = path.join(outputDir, ".bundle-meta.json");

  console.log("==> glm binary download");
  console.log(`    version:  v${expectedMeta.version}`);
  console.log(`    platform: ${platformKey}`);
  console.log(`    target:   ${binaryPath}`);

  if (fs.existsSync(binaryPath)) {
    const existingMeta = readJsonFile(metadataPath);
    if (isGlmBundleMetaMatch(existingMeta, expectedMeta)) {
      console.log(`    [skip] 已存在 glm v${expectedMeta.version}，跳过`);
      process.exit(0);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  if (forceRemoteOutput) {
    const bundledBinaryPath = path.join(localOutputDir, binaryName);
    const bundledMetadataPath = path.join(localOutputDir, ".bundle-meta.json");
    const bundledMeta = readJsonFile(bundledMetadataPath);
    if (fs.existsSync(bundledBinaryPath) && isGlmBundleMetaMatch(bundledMeta, expectedMeta)) {
      // Bugfix: 本机平台与远端平台一致时，旧逻辑会只写 bundled-agents，
      // 导致 remote deploy 在 mock-cdn 查不到对应平台资源。
      // 这里只回填版本匹配的 bundled 产物，避免把旧 GLM 二进制复制进 mock-cdn。
      fs.copyFileSync(bundledBinaryPath, binaryPath);
      writeGlmBundleMeta(outputDir, expectedMeta);
      if (platform !== "win32") {
        try {
          fs.chmodSync(binaryPath, 0o755);
        } catch {}
      }
      console.log(`    [copy] bundled -> mock-cdn (${bundledBinaryPath})`);
      process.exit(0);
    }
  }

  // Bugfix: CI（如 GitLab Docker）里系统临时目录与仓库常在不同挂载点，`rename` 会报 EXDEV；
  // 下载临时文件与目标同目录，保证同卷原子替换。
  const tmpFile = path.join(outputDir, `.glm-dl-${Date.now()}.part`);

  try {
    console.log(`    [download] ${downloadUrl}`);
    await download(downloadUrl, tmpFile);
    // Bugfix: 旧逻辑只按文件存在判断缓存，GLM 版本升级后会复用旧二进制。
    // 现在 GLM runtime version 已稳定可用，下载完成后重写二进制和 meta，后续按版本命中缓存。
    fs.rmSync(binaryPath, { force: true });
    fs.renameSync(tmpFile, binaryPath);

    if (platform !== "win32") {
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {}
    }
    writeGlmBundleMeta(outputDir, expectedMeta);

    console.log(`==> Done! glm (${platformKey}) -> ${binaryPath}`);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    console.error(`    [error] ${err.message}`);
    process.exit(1);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
