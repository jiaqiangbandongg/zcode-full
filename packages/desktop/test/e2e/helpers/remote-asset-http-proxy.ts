import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RemoteAssetHttpProxy {
  proxyUrl: string;
  requestPaths: string[];
  close(): Promise<void>;
}

export async function startRemoteAssetHttpProxy(options: {
  expectedHost: string;
  mockCdnRoot: string;
}): Promise<RemoteAssetHttpProxy> {
  const requestPaths: string[] = [];
  const sockets = new Set<Socket>();
  const mockCdnRoot = resolve(options.mockCdnRoot);
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "", `http://${request.headers.host ?? "invalid"}`);
      if (target.hostname !== options.expectedHost) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`Unexpected proxy target: ${target.host}`);
        return;
      }

      requestPaths.push(target.pathname);
      const sourcePath = resolveRemoteAssetSourcePath(mockCdnRoot, target.pathname);
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      const headers = {
        "content-length": String(sourceStat.size),
        "content-type": target.pathname.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      };
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(await readFile(sourcePath));
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (_request, socket) => socket.destroy());

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    requestPaths,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function resolveRemoteAssetSourcePath(mockCdnRoot: string, pathname: string): string {
  const decodedPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  const relativePath = decodedPath.startsWith("components/")
    ? decodedPath
    : join("releases", decodedPath);
  const sourcePath = resolve(mockCdnRoot, relativePath);
  const escaped = relative(mockCdnRoot, sourcePath);
  if (escaped === "" || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`Invalid remote asset path: ${pathname}`);
  }
  return sourcePath;
}
