import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 仅在首选卷不可用时探测已挂载卷；不挂载设备，也不扫描用户内容。 */
export async function discoverBackupVolumes(): Promise<string[]> {
  let roots: string[] = [];
  if (process.platform === "win32") {
    roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  } else if (process.platform === "darwin") {
    roots = (await readdir("/Volumes").catch(() => [])).map((name) => join("/Volumes", name));
  } else {
    const mounts = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
    roots = mounts
      .split("\n")
      .map((line) => line.split(" ")[4] ?? "")
      .map((path) =>
        path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
      )
      .filter((path) => /^\/(?:mnt|media|run\/media)\//.test(path));
  }
  const directories = await Promise.all(
    [...new Set(roots)].map(async (root) => {
      const info = await stat(root).catch(() => null);
      return info?.isDirectory() ? join(root, ".zcode-migration-backups") : null;
    }),
  );
  return directories.filter((path): path is string => path !== null);
}
