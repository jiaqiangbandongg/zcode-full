import { expect, it } from "vitest";
import { countRendererReloadAcks } from "#e2e/helpers/remote-renderer-ready-evidence";

const prefix = "[2026-10-11 12:00:00.000] [info] [pid:100] [main] [window-host-remote]";
const ack = (id: string, reason = "local-1:renderer-reload") =>
  `${prefix} renderer attachment ready, sessionId=${id}, reason=${reason}`;

it("两个不同 session 分别收到有效 reload ACK 才能证明同时恢复", () => {
  const counts = countRendererReloadAcks(
    [
      ack("a", "connect"),
      `${prefix} ignore stale renderer attachment ready, sessionId=b`,
      ack("a"),
      ack("a"),
      ack("b"),
      "",
    ].join("\n"),
  );
  expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 1 });
});

it("半行和其它进程转述的文本不能当成 Main ready 证据", () => {
  const content = `[agent] ${ack("a")}\n${ack("b")}`;
  expect([...countRendererReloadAcks(content)]).toEqual([]);
});
