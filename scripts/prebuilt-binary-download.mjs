import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  assertPrebuiltArchiveSha256,
  extractPrebuiltArchive,
  findPrebuiltBinary,
  verifyPrebuiltArchiveSha256,
} from "./prebuilt-binary-extract.mjs";

// 解包、定位与归档验真只保留 prebuilt-binary-extract.mjs 一份实现：内网下载链路与仓库归档链路
// 共用同一套 Windows tar 路径处理和 SHA-256 校验，避免两份实现漂移。继续转出以保持既有调用方接口。
export { extractPrebuiltArchive, findPrebuiltBinary, verifyPrebuiltArchiveSha256 };

const DOWNLOAD_TIMEOUT_MS = 60_000;
const PROXY_DOWNLOAD_HOSTS = new Set(["github.com", "githubusercontent.com"]);

export function shouldUsePrebuiltDownloadProxy(rawUrl) {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return PROXY_DOWNLOAD_HOSTS.has(hostname) || hostname.endsWith(".githubusercontent.com");
}

export async function downloadPrebuiltArchive(url, destinationPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = url.startsWith("https:") ? https : http;
    const file = createWriteStream(destinationPath);
    let handled = false;

    const cleanupAndReject = (error) => {
      if (handled) return;
      handled = true;
      file.close(() => {
        rmSync(destinationPath, { force: true });
        rejectPromise(error);
      });
    };

    // Bugfix：默认 deps 是内网镜像，不能因构建机的全局代理被送往外部出口；只有固定的
    // GitHub release 主机及其重定向主机读取代理环境，其他下载显式直连。
    const requestOptions = shouldUsePrebuiltDownloadProxy(url)
      ? { agent: new client.Agent({ proxyEnv: process.env }) }
      : { agent: false };
    const request = client
      .get(url, requestOptions, (response) => {
        // Bugfix：响应头成功后连接仍可能在归档写完前中断；此时 request 不再报错，文件也不会
        // finish，必须监听响应流本身，才能让 prepare 明确失败并清理半截归档。
        response.once("aborted", () => {
          cleanupAndReject(new Error(`Download aborted before completion (${url})`));
        });
        response.once("error", cleanupAndReject);

        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          handled = true;
          response.resume();
          file.close(() => {
            rmSync(destinationPath, { force: true });
            downloadPrebuiltArchive(response.headers.location, destinationPath).then(
              resolvePromise,
              rejectPromise,
            );
          });
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          cleanupAndReject(new Error(`Download failed: HTTP ${response.statusCode} (${url})`));
          return;
        }

        // 保留既有 ripgrep 下载器的原始字节语义，避免 fetch 按 Content-Encoding
        // 自动解压后再把已经变化的内容交给 tar/unzip。
        response.pipe(file);
        file.on("finish", () => {
          if (handled) return;
          handled = true;
          file.close((error) => {
            if (error) {
              rmSync(destinationPath, { force: true });
              rejectPromise(error);
              return;
            }
            resolvePromise();
          });
        });
      })
      .on("error", cleanupAndReject);

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms (${url})`));
    });

    file.on("error", cleanupAndReject);
  });
}

export async function downloadAndExtractPrebuiltBinary({
  archiveExt,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  downloadUrl,
  targetPlatform,
  validateBinary,
}) {
  const normalizedArchiveSha256 = assertPrebuiltArchiveSha256(archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const archivePath = join(tempDir, `archive.${archiveExt}`);
  const extractDir = join(tempDir, "extract");

  try {
    await downloadPrebuiltArchive(downloadUrl, archivePath);
    // Bugfix：release plan 中固定摘要的归档必须先验真，不能只校验下载内容自带的架构。
    verifyPrebuiltArchiveSha256(archivePath, normalizedArchiveSha256);
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // Bugfix: foreign target 不能靠执行下载文件验真，必须在覆盖正式路径前校验临时产物。
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}
