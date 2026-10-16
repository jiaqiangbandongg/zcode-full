import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { webContents, type BrowserWindow } from "electron";
import { getGenUiOutputDirectory } from "@zcode/shared/node";

export async function prepareOutputFiles(root: string) {
  // 回归：打开 Home 一类包含应用数据目录的工作区，固定 Gen UI 输出仍须可读。
  const workspacePath = root;
  const outputRoot = join(root, "user-data", "visualizations");
  const directory = getGenUiOutputDirectory(outputRoot, {
    workspacePath,
    workspaceIdentity: "ssh:fixture:/workspace",
    sessionId: "fixture",
  });
  await mkdir(directory, { recursive: true });
  const path = join(directory, "demo.html");
  await copyFile(join(root, "demo.html"), path);
  // fork 保留父会话的 HTML 路径；第二个会话应直接读取同一文件，不需要复制产物。
  const paths: Record<string, string> = { fixture: path, "second-task": path };
  return { workspacePath, outputRoot, paths };
}

export async function checkInheritedOutput(win: BrowserWindow): Promise<void> {
  const guestId = await win.webContents.executeJavaScript(
    "document.querySelector('[data-testid=gen-ui-anchor] webview').getWebContentsId()",
  );
  const frame = webContents
    .fromId(guestId)!
    .mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
  assert.equal(
    await frame.executeJavaScript("document.querySelector('h1').textContent"),
    "Updated heading",
  );
}
