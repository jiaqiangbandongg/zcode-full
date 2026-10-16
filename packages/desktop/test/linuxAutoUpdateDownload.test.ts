import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater } from "electron-updater";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManifestUpdateProvider } from "@desktop/main/manifestUpdateProvider.js";

// 使用真实 updater 的文件选择、缓存落盘和完成事件；仅 HTTP transport 注入 Node
// 实现，便于任意开发平台验证 Linux 下载链路，不运行提权安装或退出当前应用。
describe("Linux 自动更新下载集成", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [AppImageUpdater, "AppImage"],
    [DebUpdater, "deb"],
    [RpmUpdater, "rpm"],
    [PacmanUpdater, "pkg.tar.zst"],
  ] as const)("%s 下载 %s 并写入可安装缓存", async (Updater, extension) => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-update-"));
    const content = Buffer.from("ZCT-2100231841920471040 update download fixture");
    const checksum = createHash("sha512").update(content).digest("base64");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "Content-Length": content.length });
      response.end(content);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const origin = `http://127.0.0.1:${address.port}`;
      const updater = new Updater(undefined, {
        version: "3.12.1",
        name: "ZCode",
        isPackaged: true,
        appUpdateConfigPath: join(directory, "app-update.yml"),
        userDataPath: directory,
        baseCachePath: directory,
        whenReady: async () => {},
        relaunch: () => {},
        quit: () => {},
        onQuit: () => {},
      });
      updater.logger = null;
      updater.disableDifferentialDownload = true;
      updater.autoInstallOnAppQuit = false;
      vi.stubEnv("APPIMAGE", join(directory, "old.AppImage"));
      const provider = new ManifestUpdateProvider(
        { provider: "custom", endpointOrigin: origin },
        updater,
        { platform: "linux", executor: {} as never, isUseMultipleRangeRequest: false },
      );
      const info = {
        version: "3.12.2",
        releaseDate: "2026-09-16",
        files: ["pkg.tar.zst", "rpm", "AppImage", "deb"].map((ext) => ({
          url: `${origin}/releases/ZCode-3.12.2-linux-x64.${ext}`,
          sha512: checksum,
        })),
      };
      const downloaded = vi.fn();
      updater.on("update-downloaded", downloaded);
      Object.assign(updater, {
        updateInfoAndProvider: { info, provider },
        downloadedUpdateHelper: new DownloadedUpdateHelper(directory),
        httpExecutor: {
          download: async (url: URL, destination: string, options: { sha512: string }) => {
            const response = await fetch(url);
            const bytes = Buffer.from(await response.arrayBuffer());
            expect(createHash("sha512").update(bytes).digest("base64")).toBe(options.sha512);
            await writeFile(destination, bytes);
          },
        },
      });
      const files = await updater.downloadUpdate();
      const expectedName = `ZCode-3.12.2-linux-x64.${extension}`;
      expect(files).toEqual([join(directory, "pending", expectedName)]);
      expect(await readFile(files[0]!)).toEqual(content);
      expect(requests).toEqual([`/releases/${expectedName}`]);
      expect(downloaded).toHaveBeenCalledOnce();
      // Windows 下 electron-updater 从缓存 JSON 读回的 installerPath 分隔符会重复，
      // 且 deb/rpm/pacman 的值以分隔符结尾（AppImage 不带）。去掉尾部分隔符、normalize
      // 合并中间重复分隔符，只在"路径等价"层放宽；另以独立约束兜住格式回归：
      // 同名、绝对路径、无 ".." 段（防 normalize 解析掉路径穿越）、缓存文件真实存在。
      const installerPath = updater.installerPath ?? "";
      const installerPathCore = installerPath.replace(/[\\/]+$/, "");
      expect(normalize(installerPathCore)).toBe(normalize(files[0]!));
      expect(basename(installerPathCore)).toBe(expectedName);
      expect(isAbsolute(installerPath)).toBe(true);
      expect(installerPath.split(/[\\/]+/)).not.toContain("..");
      expect(existsSync(installerPath)).toBe(true);
      const cached = JSON.parse(
        await readFile(join(directory, "pending", "update-info.json"), "utf8"),
      );
      expect(cached.fileName).toBe(expectedName);
      expect(cached.sha512).toBe(checksum);
      // 再次下载必须命中同一缓存，尤其不能因 pacman 的 URL/文件名差异重新下载。
      await updater.downloadUpdate();
      expect(requests).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
