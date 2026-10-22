import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function stageE2EAppOutput(sourceDir: string, destinationDir: string) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        await stageE2EAppOutput(sourcePath, destinationPath);
        return;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported E2E app output entry: ${sourcePath}`);
      }
      // 硬链接共享 inode，类型检查原地覆盖 out 或用例改写副本都会污染其他运行。
      // 写时复制使用独立 inode；不支持克隆的文件系统由 Node 自动回退为普通复制。
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
    }),
  );
}
