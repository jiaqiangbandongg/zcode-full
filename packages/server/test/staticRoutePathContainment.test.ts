import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import win32 from "node:path/win32";
import posix from "node:path/posix";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, isInsideDirectory, isPathDriveQualified } from "../src/http.js";

// 背景：Windows 上 path.resolve('C:\\web', 'Z:/x') 直接切到 Z 盘，而跨盘时
// path.relative 返回的是绝对路径（不以 ".." 开头），旧的越界检查因此把它误判为
// 「静态根目录内」，通配静态路由又不在 token 中间件保护范围内，导致另一块盘上
// 的任意文件可被未授权读取（含 %3A 编码形式与映射的网络盘）。这里固化三道防线：
// 盘符路径前置拒绝、relative 结果为绝对路径一律视为越界、以及原有 ".." 检查回归。

describe("isPathDriveQualified", () => {
  it("识别 URL 形式与反斜杠形式的盘符路径", () => {
    expect(isPathDriveQualified("Z:/marker.txt")).toBe(true);
    expect(isPathDriveQualified("z:\\marker.txt")).toBe(true);
    // 无分隔符的盘符相对路径在 win32 resolve 下同样会切盘（resolve 成 Z:\<file>）
    expect(isPathDriveQualified("Z:marker.txt")).toBe(true);
  });

  it("不误伤正常相对路径", () => {
    expect(isPathDriveQualified("assets/app.js")).toBe(false);
    expect(isPathDriveQualified("assets/Z-report.txt")).toBe(false);
    expect(isPathDriveQualified("index.html")).toBe(false);
  });
});

describe("isInsideDirectory", () => {
  it("win32 跨盘符：relative 返回绝对路径，必须判为越界（回归用例）", () => {
    // 修复前：path.win32.relative('C:\\zcode\\web', 'Z:\\marker.txt') === 'Z:\\marker.txt'
    // 不以 ".." 开头，被旧实现误判为在目录内
    expect(isInsideDirectory("C:\\zcode\\web", "Z:\\marker.txt", win32)).toBe(false);
    expect(
      isInsideDirectory("C:\\zcode\\web", win32.resolve("C:\\zcode\\web", "index.html"), win32),
    ).toBe(true);
  });

  it("posix 语义保持不变", () => {
    expect(isInsideDirectory("/srv/web", "/srv/web/assets/app.js", posix)).toBe(true);
    expect(isInsideDirectory("/srv/web", "/srv/web", posix)).toBe(true);
    expect(isInsideDirectory("/srv/web", "/srv/etc/passwd", posix)).toBe(false);
    expect(isInsideDirectory("/srv/web", "/srv/web/../secret", posix)).toBe(false);
  });
});

describe("static route path containment", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolveClose();
            });
          }),
      ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  async function startStaticServer(): Promise<number> {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>home</html>");
    const server = createHttpServer(new ServiceCollection(), 0, {
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it("盘符路径（明文与 %3A 编码）一律 404，不再解析到其他盘", async () => {
    const port = await startStaticServer();
    expect((await fetch(`http://127.0.0.1:${port}/Z:/marker.txt`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/Z%3A/marker.txt`)).status).toBe(404);
  });

  it("编码形式的 .. 在 WHATWG URL 归一化后落回根内，未命中时走 SPA fallback 而非越界", async () => {
    const port = await startStaticServer();
    const response = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret.txt`);
    // new URL() 会把 %2e%2e 折叠为 .. 并归一化路径，路由收到的是根内的 /secret.txt；
    // 该文件不存在，落到 SPA fallback 返回 index.html —— 证明响应来自 fallback 而非越界文件
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>home</html>");
  });
});
