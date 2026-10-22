import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { createFirstConnectionStallingSSHProxy } from "./e2e/helpers/ssh-remote-p0.js";

describe("SSH首连接暂停代理", () => {
  it("暂停握手但读取客户端banner，使取消后的FIN能被观测", async () => {
    const proxy = await createFirstConnectionStallingSSHProxy(
      { host: "127.0.0.1", port: 9 },
      "R3_PROXY_FIN",
    );
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await proxy.firstConnectionAccepted;
      client.end("SSH-2.0-r3-fixture\r\n");
      const closed = await Promise.race([
        proxy.waitForFirstConnectionClosed().then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      expect(closed).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      client.destroy();
      await proxy.close();
    }
  });
});
