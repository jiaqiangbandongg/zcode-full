import { mkdir, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ComposerPrefillExpectation {
  attachments?: ComposerPrefillAttachment[];
  attachmentLocalPaths?: Record<string, string>;
  attachmentFilenames: string[];
  text: string;
}

export type ComposerPrefillAttachment =
  | {
      dataBase64?: string;
      filename: string;
      kind: "image";
      localPath?: string;
      mimeType: string;
      sizeBytes: number;
    }
  | {
      filename: string;
      kind: "file";
      localPath?: string;
      mimeType: string;
      sizeBytes: number;
      textContent?: string;
    };

const PNG_FIXTURE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAATUlEQVR4AeXBMQEAIAzAsK43KlCBf2NMSJM5933CJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJG4B7pwBpTup40wAAAAASUVORK5CYII=";
const PNG_FIXTURE_SIZE_BYTES = 134;

export async function writeComposerPrefillPngFixture(localPath: string) {
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, Buffer.from(PNG_FIXTURE_BASE64, "base64"));
}

export async function writeOversizedComposerPrefillPngFixture(
  localPath: string,
  sizeBytes: number,
) {
  await writeComposerPrefillPngFixture(localPath);
  // 修复原因：agent 侧会重新 stat 本地图片大小；只改 composer metadata 不能覆盖真实大图路径引用分支。
  await truncate(localPath, sizeBytes);
}

export async function setComposerPrefill(
  taskId: string | null,
  expectation: ComposerPrefillExpectation,
) {
  const result = (await browser.execute(
    (taskIdArg, nextExpectation, pngBase64, pngSizeBytes) => {
      const bridge = (
        window as typeof window & {
          __zcodeSessionStoreE2E?: {
            getState?: () => {
              setPendingComposerPrefill?: (
                workspacePath: string,
                prefill: {
                  attachments: Array<
                    | {
                        dataBase64?: string;
                        filename: string;
                        kind: "image";
                        localPath?: string;
                        mimeType: string;
                        sizeBytes: number;
                      }
                    | {
                        filename: string;
                        kind: "file";
                        localPath?: string;
                        mimeType: string;
                        sizeBytes: number;
                        textContent?: string;
                      }
                  >;
                  taskId: string;
                  text: string;
                },
              ) => void;
              workspaces?: Record<string, { activeTaskId?: string | null }>;
            };
          };
        }
      ).__zcodeSessionStoreE2E;
      const state = bridge?.getState?.();
      if (!state?.setPendingComposerPrefill) {
        return { ok: false, reason: "store-missing" };
      }

      const workspaces = state.workspaces ?? {};
      const workspaceEntry =
        Object.entries(workspaces).find(([, workspace]) =>
          taskIdArg === null
            ? workspace.activeTaskId === null
            : workspace.activeTaskId === taskIdArg,
        ) ?? Object.entries(workspaces)[0];
      if (!workspaceEntry) {
        return { ok: false, reason: "workspace-missing" };
      }

      const [workspacePath] = workspaceEntry;
      const attachments =
        nextExpectation.attachments ??
        nextExpectation.attachmentFilenames.map((filename) => {
          const localPath = nextExpectation.attachmentLocalPaths?.[filename];
          if (filename.endsWith(".png")) {
            return {
              kind: "image" as const,
              filename,
              mimeType: "image/png",
              sizeBytes: pngSizeBytes,
              ...(localPath ? { localPath } : { dataBase64: pngBase64 }),
            };
          }
          return {
            kind: "file" as const,
            filename,
            mimeType: filename.endsWith(".md") ? "text/markdown" : "text/plain",
            ...(localPath
              ? { localPath }
              : { textContent: `E2E composer draft attachment ${filename}` }),
            sizeBytes: filename.length,
          };
        });

      state.setPendingComposerPrefill(workspacePath, {
        taskId: taskIdArg ?? "__draft__",
        text: nextExpectation.text,
        attachments,
      });
      return { ok: true, count: attachments.length };
    },
    taskId,
    expectation,
    PNG_FIXTURE_BASE64,
    PNG_FIXTURE_SIZE_BYTES,
  )) as { count?: number; ok: boolean; reason?: string };

  const expectedAttachmentCount = expectation.attachments?.length ?? expectation.attachmentFilenames.length;
  if (!result.ok || result.count !== expectedAttachmentCount) {
    throw new Error(`设置 composer prefill 附件失败: ${JSON.stringify(result)}`);
  }
}

export async function waitForVisibleAttachmentNames(filenames: string[]) {
  await browser.waitUntil(
    async () =>
      browser.execute((expectedFilenames) => {
        const bodyText = document.body.innerText;
        return expectedFilenames.every((filename) => bodyText.includes(filename));
      }, filenames),
    {
      timeout: 10000,
      timeoutMsg: `composer 附件没有显示: ${filenames.join(", ")}`,
    },
  );
}
