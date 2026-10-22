import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { withCredentialFault } from "#e2e/helpers/credential-fault";

it.each([undefined, "original"])(
  "故障收尾只恢复注入键，保留连接期间新增的 SSH 凭据 (%s)",
  async (original) => {
    const directory = await mkdtemp(join(tmpdir(), "credential-fault-"));
    const file = join(directory, "credentials.json");
    const initial = original === undefined ? {} : { oauth: original };
    try {
      await writeFile(file, JSON.stringify(initial));
      await expect(
        withCredentialFault(file, "oauth", "invalid", async () => {
          await withFileLock(file, async () => {
            const current = JSON.parse(await readFile(file, "utf8"));
            expect(current.oauth).toBe("invalid");
            await atomicWritePrivateTextFile(
              file,
              JSON.stringify({ ...current, ssh: "new-credential" }),
            );
          });
          throw new Error("injected failure");
        }),
      ).rejects.toThrow("injected failure");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        ...initial,
        ssh: "new-credential",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
