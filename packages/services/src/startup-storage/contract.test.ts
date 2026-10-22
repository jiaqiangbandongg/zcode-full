import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startupStorage } from "./index.js";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function command(source: string) {
  directory = await realpath(await mkdtemp(join(tmpdir(), "zcode startup migration ")));
  const file = join(directory, "fake cli.cjs");
  await writeFile(file, source);
  return {
    command: process.execPath,
    args: [file, "app-server", "--stdio", "--surface", "desktop"],
    cwd: directory,
  };
}
it("awaits the resolved CLI migration command, preserves paths and data root, and validates its report", async () => {
  const fixture = await command(`
    if (JSON.stringify(process.argv.slice(2)) !== '["storage-migrate"]') process.exit(2);
    if (process.env.ZCODE_DATA_BASE_DIR !== process.cwd()) process.exit(3);
    process.stdout.write(JSON.stringify({version:1,kind:"storage-migrated",applied:["0020"],backupSkipped:true}));
  `);
  await expect(
    startupStorage.migrateAgent({
      command: fixture,
      env: { ...process.env, ZCODE_DATA_BASE_DIR: directory },
    }),
  ).resolves.toEqual({ applied: ["0020"], backupSkipped: true });
});
it.each([
  ['process.stderr.write("checksum mismatch"); process.exit(1);', /checksum mismatch/],
  ['process.stdout.write("{}");', /migration/i],
  [
    'process.stdout.write(JSON.stringify({version:2,kind:"storage-migrated",applied:[],backupSkipped:false}));',
    /migration/i,
  ],
])(
  "rejects failed or incompatible completion without admitting startup",
  async (source, expected) => {
    await expect(startupStorage.migrateAgent({ command: await command(source) })).rejects.toThrow(
      expected,
    );
  },
);
it("does not guess an executable command that lacks the Agent subcommand", async () => {
  await expect(
    startupStorage.migrateAgent({ command: { command: process.execPath, args: ["wrapper.cjs"] } }),
  ).rejects.toThrow(/command/);
});
