import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("E2E observer records stderr, exit code and final frame without changing Worker outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-observer-"));
  const entry = join(dir, "fixture.cjs");
  const artifacts = join(dir, "artifacts");
  try {
    await writeFile(
      entry,
      `process.stderr.write("fixture startup failure\\n", () => {
      process.stdout.write(JSON.stringify({method:"startup/storagePath",params:{path:"/fixture/db.sqlite"}})+"\\n", () => process.exit(23));
    });`,
    );
    const probe = `const { Worker } = await import('node:worker_threads');
      const { once } = await import('node:events');
      const worker = new Worker(${JSON.stringify(entry)}, { argv:['--prepare-storage'], stdout:true, stderr:true });
      worker.stdout.resume(); worker.stderr.resume();
      const [code] = await once(worker, 'exit');
      if (code !== 23) throw new Error('observer changed exit code');`;
    const probePath = join(dir, "probe.mjs");
    await writeFile(probePath, probe);
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        new URL("./e2e/helpers/storage-worker-diagnostics.mjs", import.meta.url).href,
        probePath,
      ],
      { env: { ...process.env, ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS_DIR: artifacts } },
    );
    const files = await readdir(artifacts);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(artifacts, files[0]!), "utf8"))).toMatchObject({
      exitCode: 23,
      stderr: "fixture startup failure\n",
      workerError: null,
      lastFrame: { method: "startup/storagePath", params: { path: "/fixture/db.sqlite" } },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
