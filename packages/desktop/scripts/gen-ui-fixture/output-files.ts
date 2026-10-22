import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { webContents, type BrowserWindow } from "electron";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { IGenUiService } from "@zcode/services";

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
  const remoteOutputRoot = join(root, "remote-user-data", "visualizations");
  await mkdir(remoteOutputRoot, { recursive: true });
  const remotePath = join(remoteOutputRoot, "demo.html");
  await copyFile(path, remotePath);
  const remotePaths = { fixture: remotePath, "second-task": remotePath };
  return { workspacePath, outputRoot, paths, remoteOutputRoot, remotePaths };
}

export async function checkRemoteOutput(
  win: BrowserWindow,
  desktop: IGenUiService,
  remote: IGenUiService,
  output: Awaited<ReturnType<typeof prepareOutputFiles>>,
  root: string,
  waitHost: (predicate: string) => Promise<unknown>,
) {
  const target = {
    workspacePath: output.workspacePath,
    workspaceIdentity: "ssh:fixture:/workspace",
    sessionId: "fixture",
    path: output.remotePaths.fixture,
  };
  // 两端目录必须不同；不能让远端身份的本地文件夹具掩盖错误的服务接线。
  await assert.rejects(desktop.readDocument(target), /outside the host output directory/);
  await win.loadFile(join(root, "react.html"), { query: { source: "1" } });
  await waitHost("window.showReply");
  await win.webContents.executeJavaScript("window.showReply('complete')");
  await waitHost("document.querySelector('[data-gen-ui-phase=ready]')");
  await checkInheritedOutput(win);
  const guestId = await win.webContents.executeJavaScript(
    "document.querySelector('[data-testid=gen-ui-anchor] webview').getWebContentsId()",
  );
  const frame = webContents
    .fromId(guestId)!
    .mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
  await frame.executeJavaScript(
    "window.zcode.setWidgetState({modelContent:{remote:42},privateContent:{desktop:true}})",
  );
  assert.deepEqual(await desktop.getState(target), {
    modelContent: { remote: 42 },
    privateContent: { desktop: true },
  });
  assert.equal(await remote.getState(target), null);
  await win.webContents.executeJavaScript(
    "window.showReply('hidden'); window.deleteTask('fixture')",
  );
  await waitHost("!document.querySelector('webview')");
  const before = await win.webContents.executeJavaScript("window.inspectReact().reads");
  await win.setContentSize(390, 780);
  await win.webContents.executeJavaScript("window.showMobile()");
  await waitHost(
    "document.querySelector('[role=status]')?.textContent.includes('Open this interactive view in the desktop app')",
  );
  assert.equal(await win.webContents.executeJavaScript("window.inspectReact().reads"), before);
  assert.equal(
    await win.webContents.executeJavaScript("document.querySelectorAll('webview').length"),
    0,
  );
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
