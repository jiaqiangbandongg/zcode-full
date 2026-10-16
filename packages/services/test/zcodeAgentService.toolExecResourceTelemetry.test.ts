import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZCodeToolExecResource } from "@zcode/shared";
import { expect, it } from "vitest";
import { createZCodeAgentService } from "#src/zcode-agent/zcodeAgentService.js";
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";

it("真实 stdio 严格解析 Bash 完成事实，只允许 trusted Host 订阅", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-resource-"));
  const sample: ZCodeToolExecResource = {
    platform: "linux",
    toolName: "bash",
    durationMs: 40000,
    exitKind: "completed",
    sampleCount: 2,
    treeRssKbPeak: 300,
    treeCpuTimeMs: 6000,
    cliRssKb: 1024,
    systemFreeMemoryKb: 2048,
  };
  const script = join(root, "agent.cjs");
  await writeFile(
    script,
    `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method !== 'session/list') return;
  const sample = ${JSON.stringify(sample)};
  for (const extra of [{ command: 'secret' }, { cwd: '/secret' }, { sampleCount: 21 }])
    send({ method: 'process/toolExecResource', params: { ...sample, ...extra } });
  send({ method: 'process/toolExecResource', params: sample });
  send({ id: request.id, result: { sessions: [] } });
});`,
  );
  const service = createZCodeAgentService({
    commandResolver: () => ({ command: process.execPath, args: [script] }),
  });
  const relay = createZCodeAgentConnectionScope(service, {
    connectionId: "relay",
    clientMode: "desktop-continuous",
    role: "trusted-host-relay",
  });
  const desktop = createZCodeAgentConnectionScope(relay.service, {
    connectionId: "desktop",
    clientMode: "desktop-continuous",
  });
  const mobile = createZCodeAgentConnectionScope(relay.service, {
    connectionId: "mobile",
    clientMode: "web-remote-replayable",
  });
  const seen: ZCodeToolExecResource[] = [];
  const forbidden: ZCodeToolExecResource[] = [];
  try {
    relay.service.onDynamicToolExecResource()((event) => seen.push(event));
    desktop.service.onDynamicToolExecResource()((event) => forbidden.push(event));
    mobile.service.onDynamicToolExecResource()((event) => forbidden.push(event));
    await service.listSessions({ workspacePath: root });
    expect(seen).toEqual([sample]);
    expect(forbidden).toEqual([]);
  } finally {
    await Promise.all([relay.dispose(), desktop.dispose(), mobile.dispose()]);
    await service.disposeAllAndWait();
    await rm(root, { recursive: true, force: true });
  }
});
