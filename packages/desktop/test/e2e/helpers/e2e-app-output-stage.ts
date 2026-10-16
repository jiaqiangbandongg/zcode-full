import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

interface StageE2EAppOutputOptions {
  copyFile?: typeof copyFile;
  linkFile?: typeof link;
}

const LINK_FALLBACK_ERROR_CODES = new Set(["EACCES", "EPERM", "EXDEV", "ENOTSUP"]);

export async function stageE2EAppOutput(
  sourceDir: string,
  destinationDir: string,
  options: StageE2EAppOutputOptions = {},
) {
  const linkFile = options.linkFile ?? link;
  const copyFallback = options.copyFile ?? copyFile;
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        await stageE2EAppOutput(sourcePath, destinationPath, options);
        return;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported E2E app output entry: ${sourcePath}`);
      }
      try {
        await linkFile(sourcePath, destinationPath);
      } catch (error) {
        if (!isLinkFallbackError(error)) {
          throw error;
        }
        await copyFallback(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
      }
    }),
  );
}

function isLinkFallbackError(error: unknown) {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" && LINK_FALLBACK_ERROR_CODES.has(code);
}
