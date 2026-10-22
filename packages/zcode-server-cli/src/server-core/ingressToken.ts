import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { ServerLayout } from "../runtime/paths.js";

export async function createIngressToken(layout: ServerLayout): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
  const temporary = `${layout.ingressTokenFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, layout.ingressTokenFile);
    if (process.platform !== "win32") await chmod(layout.ingressTokenFile, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return token;
}
