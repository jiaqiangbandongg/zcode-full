import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ServerLayout } from "./paths.js";

const SERVER_INSTALL_OWNERSHIP_PRODUCT = "zcode-server";
const SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION = 1;

const serverInstallOwnershipSchema = z.object({
  product: z.literal(SERVER_INSTALL_OWNERSHIP_PRODUCT),
  schemaVersion: z.literal(SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION),
  canonicalServerRoot: z.string().min(1),
  installationId: z.string().uuid(),
  installedAt: z.number().int().nonnegative(),
}).strict();

export type ServerInstallOwnership = z.infer<typeof serverInstallOwnershipSchema>;

async function readOwnership(layout: ServerLayout): Promise<ServerInstallOwnership> {
  const markerStat = await lstat(layout.installFile).catch(() => null);
  if (!markerStat?.isFile()) {
    throw new Error(`ZCode Server ownership marker is missing or invalid: ${layout.installFile}`);
  }
  try {
    return serverInstallOwnershipSchema.parse(JSON.parse(await readFile(layout.installFile, "utf8")));
  } catch (error) {
    throw new Error(`ZCode Server ownership marker is invalid: ${layout.installFile}`, { cause: error });
  }
}

export async function ensureServerInstallOwnership(layout: ServerLayout): Promise<ServerInstallOwnership> {
  await mkdir(layout.serverRoot, { recursive: true, mode: 0o700 });
  const canonicalServerRoot = await realpath(layout.serverRoot);
  const ownership: ServerInstallOwnership = {
    product: SERVER_INSTALL_OWNERSHIP_PRODUCT,
    schemaVersion: SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION,
    canonicalServerRoot,
    installationId: randomUUID(),
    installedAt: Date.now(),
  };
  await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
  const temporary = join(layout.runDir, `install-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(ownership, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      // 直接 open install.json 后再写入会先暴露空文件，并发 ensure 可能把
      // 它判成损坏 marker。hard-link 只在临时文件完整落盘后原子发布且不会覆盖旧标记。
      await link(temporary, layout.installFile);
      return ownership;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return await validateServerInstallOwnership(layout);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function validateServerInstallOwnership(layout: ServerLayout): Promise<ServerInstallOwnership> {
  const [ownership, canonicalServerRoot] = await Promise.all([
    readOwnership(layout),
    realpath(layout.serverRoot).catch((error: unknown) => {
      throw new Error(`ZCode Server ownership root cannot be resolved: ${layout.serverRoot}`, { cause: error });
    }),
  ]);
  if (ownership.canonicalServerRoot !== canonicalServerRoot) {
    throw new Error(
      `ZCode Server ownership root mismatch: expected ${ownership.canonicalServerRoot}, received ${canonicalServerRoot}`,
    );
  }
  return ownership;
}
