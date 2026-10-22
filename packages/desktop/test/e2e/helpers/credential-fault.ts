import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

/** 故障期间连接流程也会保存凭据；不能用测试开始前的整文件快照覆盖这些新值。 */
export async function withCredentialFault<T>(
  file: string,
  key: string,
  invalidValue: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = await withFileLock(file, async () => {
    const current: Record<string, string> = JSON.parse(await readFile(file, "utf8"));
    const previous = current[key];
    current[key] = invalidValue;
    await atomicWritePrivateTextFile(file, JSON.stringify(current));
    return previous;
  });
  try {
    return await operation();
  } finally {
    await withFileLock(file, async () => {
      const current: Record<string, string> = JSON.parse(await readFile(file, "utf8"));
      if (previous === undefined) delete current[key];
      else current[key] = previous;
      await atomicWritePrivateTextFile(file, JSON.stringify(current));
    });
  }
}
