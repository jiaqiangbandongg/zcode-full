import { join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  clickChatSend,
  countUpstreamRequestsContaining,
  getMessages,
  prepareConversationE2E,
  setComposerPrefill,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
  waitForVisibleAttachmentNames,
  writeOversizedComposerPrefillPngFixture,
} from "../../../helpers/conversation-session.js";

const OVERSIZED_INLINE_IMAGE_TIMEOUT_MS = 180000;
const OVERSIZED_IMAGE_BYTES = 21 * 1024 * 1024;

describe("会话区超大图片附件边界 E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("T04: 无 localPath 的超大图片点击发送后应保留草稿且不发 provider 请求", async function () {
    this.timeout(OVERSIZED_INLINE_IMAGE_TIMEOUT_MS);

    await prepareConversationE2E();

    const runId = Date.now();
    const marker = `E2E_OVERSIZED_INLINE_IMAGE_${runId}`;
    const filename = `oversized-inline-${runId}.png`;
    const prompt = `${marker}: this prompt must stay in composer because the inline image is too large.`;
    // 修复验证原因：工单根因是无本地路径图片会在 renderer 内联为 base64。
    // 这里只写入无内容的 21MiB image metadata，避免 E2E 为了造状态先解码大 base64。
    await setComposerPrefill(null, {
      attachmentFilenames: [filename],
      attachments: [
        {
          filename,
          kind: "image",
          mimeType: "image/png",
          sizeBytes: OVERSIZED_IMAGE_BYTES,
        },
      ],
      text: prompt,
    });
    await waitForComposerText(prompt, "无路径超大图片 case 没有恢复预填正文");
    await waitForVisibleAttachmentNames([filename]);

    const requestCountBefore = await countUpstreamRequestsContaining(marker);
    await clickChatSend();
    await waitForOversizedImageError(filename);
    await waitForComposerText(prompt, "无路径超大图片发送前拦截后没有保留正文");
    await waitForVisibleAttachmentNames([filename]);

    await browser.pause(2500);
    const requestCountAfter = await countUpstreamRequestsContaining(marker);
    expect(requestCountAfter).toBe(requestCountBefore);
    const userMessages = await getMessages("user");
    expect(userMessages.some((message) => message.text.includes(marker))).toBe(false);
  });

  it("T05: 有 localPath 的超大图片应以路径引用发送且不携带 dataBase64", async function () {
    this.timeout(OVERSIZED_INLINE_IMAGE_TIMEOUT_MS);

    await prepareConversationE2E();

    const runId = Date.now();
    const marker = `E2E_OVERSIZED_LOCAL_PATH_IMAGE_${runId}`;
    const filename = `oversized-local-path-${runId}.png`;
    const localPath = join(DEFAULT_WORKSPACE, filename);
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await writeOversizedComposerPrefillPngFixture(localPath, OVERSIZED_IMAGE_BYTES);
    // 修复验证原因：agent 会按磁盘 stat.size 判断本地图片是否内联。
    // 因此 T05 必须使用真实超过 20MiB 的文件，才能证明 provider 请求不会携带 data URL。
    await setComposerPrefill(null, {
      attachmentFilenames: [filename],
      attachments: [
        {
          filename,
          kind: "image",
          localPath,
          mimeType: "image/png",
          sizeBytes: OVERSIZED_IMAGE_BYTES,
        },
      ],
      text: prompt,
    });
    await waitForComposerText(prompt, "有路径超大图片 case 没有恢复预填正文");
    await waitForVisibleAttachmentNames([filename]);

    await clickChatSend();
    await waitForComposerText("", "有路径超大图片发送后输入框没有清空");
    await waitForUserMessageContaining(marker);

    const record = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(record, {
      expectedText: prompt,
      model: UPSTREAM_MODEL,
    });
    assertLocalPathImageAttachmentRequest(record.requestJson, { filename, localPath });

    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "有路径超大图片发送完成后没有回到 idle",
      90000,
    );
  });
});

function assertLocalPathImageAttachmentRequest(
  requestJson: unknown,
  expected: { filename: string; localPath: string },
) {
  expect(containsText(requestJson, expected.filename)).toBe(true);
  expect(containsText(requestJson, expected.localPath)).toBe(true);
  expect(containsObjectKey(requestJson, "dataBase64")).toBe(false);
  expect(containsText(requestJson, "data:image")).toBe(false);
}

function containsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => containsText(child, expected));
}

function containsObjectKey(value: unknown, expectedKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, expectedKey));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, expectedKey) ||
    Object.values(record).some((child) => containsObjectKey(child, expectedKey))
  );
}

async function waitForOversizedImageError(filename: string) {
  let latestText = "";
  await browser.waitUntil(
    async () => {
      latestText = await getAttachmentErrorText();
      return latestText.includes(filename) && latestText.includes("20 MB");
    },
    {
      timeout: 10000,
      timeoutMsg: `没有显示超大图片附件错误; latest=${latestText}`,
    },
  );
}

function getAttachmentErrorText() {
  return browser.execute(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
    return (
      candidates
        .map((element) => element.innerText.replace(/\u00a0/g, " ").trim())
        .find((text) => text.includes("20 MB")) ?? ""
    );
  });
}
