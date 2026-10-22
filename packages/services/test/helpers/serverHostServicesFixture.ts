import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IProjectService, ISourceServerWorkspaceService } from "@zcode/services";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import { createServerHostServices, disposeServiceResourcesAndWait } from "../../src/node.js";

const home = process.env.HOME!;
const host = await createServerHostServices({
  sourceServerId: "server-owner",
  zcodeBuiltinProviderConfigFilePath: resolve("config/provider/zcode-builtin.json"),
});
try {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT id FROM schema_migration WHERE id='0005_projects'").get());
  } finally {
    db.close();
  }
  const root = join(home, "repo");
  await mkdir(root);
  const project = await host.services
    .get(IProjectService)
    .saveProject({ name: "Server", roots: [root], primaryRoot: root });
  assert.equal(project.hostId, "remote:server:server-owner");
  const mapping = await host.services
    .get(ISourceServerWorkspaceService)
    .resolveWorkspace({ workspacePath: root });
  assert.deepEqual(
    host.workspaceIdentityMapper.mapIncoming({
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: "server-owner",
        workspacePath: root,
      }),
    }),
    { workspaceIdentity: mapping.canonicalWorkspaceKey },
  );
  assert.equal((await host.services.get(IProjectService).readTree()).projects.length, 1);
} finally {
  await disposeServiceResourcesAndWait(host.services);
}
process.stdout.write("SERVER_HOST_VERIFIED\n");
// 独立 Host 与真实入口一样以进程为环境隔离边界，父进程等待 exit 后清理 HOME。
process.exit(0);
