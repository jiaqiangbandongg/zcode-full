import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

function normalizePath(file) {
  return file.replaceAll("\\", "/");
}

function shellQuote(value) {
  if (process.platform === "win32") {
    // Bugfix: Windows 的 pre-push 路径会在 lint-staged 临时 GIT_INDEX_FILE 下 spawn
    // 返回的命令字符串；POSIX 单引号在这里可能被当成可执行参数的一部分，导致任务无法启动。
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteFiles(files) {
  return files.map(shellQuote).join(" ");
}

function writeFilesManifest(mode, files) {
  const manifestPath = `.lint-staged-vitest-${process.pid}-${randomUUID()}.json`;
  writeFileSync(
    manifestPath,
    JSON.stringify({
      mode,
      files,
    }),
  );
  return manifestPath;
}

function vitestCommand(mode, files) {
  // 不按文件拆批：重复启动 Vitest 会增加开销，related 拆批还会重复执行共同依赖的测试。
  // Bugfix: Windows 下 lint-staged 返回的是 shell command string，文件名里的 %PATH%
  // 会先被 cmd.exe 展开。文件列表写入 manifest，只把安全生成的 manifest 路径传给 Node。
  const manifestPath = writeFilesManifest(mode, files);
  return `node scripts/run-lint-staged-vitest.mjs ${mode} --files-manifest ${quoteFiles([
    manifestPath,
  ])}`;
}

function isRootUnitTestFile(file) {
  return (
    /^packages\/[^/]+\/test\/.*\.test\.ts$/u.test(file) &&
    !file.startsWith("packages/desktop/test/e2e/")
  );
}

function isRootVitestSourceFile(file) {
  return (
    file.startsWith("packages/") &&
    !file.startsWith("packages/desktop/test/e2e/") &&
    !isRootUnitTestFile(file)
  );
}

export default {
  "packages/*/test/**/*.test.ts": (files) => {
    const testFiles = files.map(normalizePath).filter(isRootUnitTestFile);

    if (testFiles.length === 0) {
      return [];
    }

    return vitestCommand("run", testFiles);
  },
  "packages/**/*.{js,jsx,ts,tsx,json}": (files) => {
    const sourceFiles = files.map(normalizePath).filter(isRootVitestSourceFile);

    if (sourceFiles.length === 0) {
      return [];
    }

    return vitestCommand("related", sourceFiles);
  },
};
