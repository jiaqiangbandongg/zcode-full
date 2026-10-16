import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { GEN_UI_OUTPUT_ROOT_ENV, getGenUiOutputDirectory } from "@zcode/shared/node";
import { getDataBaseDir, setDataBaseDir } from "../paths.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";

it("passes the executor data directory to the spawned Agent over environment overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen-ui-spawn-"));
  const previous = getDataBaseDir();
  setDataBaseDir(root);
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      args: [
        "-e",
        `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:request.id,result:process.env.${GEN_UI_OUTPUT_ROOT_ENV}})+'\\n');
      });`,
      ],
      env: { [GEN_UI_OUTPUT_ROOT_ENV]: join(root, "wrong-command-root") },
    }),
    resolveSpawnEnv: async () => ({ [GEN_UI_OUTPUT_ROOT_ENV]: join(root, "wrong-inherited-root") }),
  });
  try {
    const client = await manager.getClient({ workspacePath: root });
    const outputRoot = await client.request("session/list", {}, z.string());
    expect(outputRoot).toBe(join(root, ".zcode", "v2", "visualizations"));
    const scope = { workspacePath: join(root, "project"), sessionId: "s" };
    expect(getGenUiOutputDirectory(outputRoot, scope)).toContain(outputRoot);
  } finally {
    await manager.disposeAllAndWait();
    setDataBaseDir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
