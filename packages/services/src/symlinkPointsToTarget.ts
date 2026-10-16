import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** 判断 linkPath 是否为指向 targetPath（同 realpath）的目录软链/交接点。 */
export async function symlinkPointsToTarget(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  const targetReal = await realpath(targetPath).catch(() => null);
  if (!targetReal) {
    return false;
  }
  try {
    const stat = await lstat(linkPath);
    let rawLinked: string;
    if (stat.isSymbolicLink()) {
      rawLinked = await readlink(linkPath);
    } else if (process.platform === "win32") {
      // 目录交接点（junction）在部分 Node 版本上 isSymbolicLink() 为 false，但仍可读 link 目标。
      try {
        rawLinked = await readlink(linkPath);
      } catch {
        return false;
      }
    } else {
      return false;
    }
    const linkedPath = isAbsolute(rawLinked) ? rawLinked : join(dirname(linkPath), rawLinked);
    const linkedReal = await realpath(linkedPath).catch(() => null);
    return linkedReal !== null && linkedReal === targetReal;
  } catch {
    return false;
  }
}
