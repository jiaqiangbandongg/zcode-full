import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
} from "../../../helpers/conversation-session.js";
import { getToastMessages } from "../../../helpers/conversation-session-toast.js";
import { selectV4TaskById, startNewV4Draft } from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_CONVERSATION_SHARE_LOCAL_V1";
const PREVIEW_CASE_MARKER = "E2E_CONVERSATION_SHARE_PREVIEW_V1";
const PREVIEW_CASE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "conversation-share-preview");
const PREVIEW_PDF = "晨报_2026-09-08_早会版.pdf";
const PREVIEW_VIDEOS = ["condensed.mp4", "纵横四海_电影解说.mp4", "final_subtitled.mp4"] as const;

describe(`${CASE_MARKER}: Desktop local 分享发布与导入入口`, () => {
  after(async () => {
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("SHARE18/SHARE-E2E-01 trusted attachment 发布已完成轮次并展示成功结果操作", async function () {
    this.timeout(240_000);
    await prepareConversationE2E();
    await sendPrompt(`${CASE_MARKER}: reply with exactly share-local-ready`);
    await waitForAssistantMessageContaining("share-local-ready");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "分享前会话没有进入终态",
      90_000,
    );
    await sendPrompt(`${CASE_MARKER}: reply with exactly share-local-ready-second`);
    await waitForAssistantMessageContaining("share-local-ready-second");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "第二轮分享前会话没有进入终态",
      90_000,
    );

    const shareButton = await $("[data-testid=conversation-share-trigger]");
    await shareButton.waitForClickable();
    // 回归原因：分享误用 icon-lg，导致热区及背景比相邻工具栏按钮大一圈。
    const toolbarGeometry = await browser.execute(() => {
      const measure = (selector: string) => {
        const button = document.querySelector<HTMLElement>(selector)!;
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          radius: getComputedStyle(button).borderRadius,
          iconWidth: icon.width,
          iconHeight: icon.height,
        };
      };
      return {
        share: measure('[data-testid="conversation-share-trigger"]'),
        terminal: measure('[data-testid="terminal-toggle"]'),
      };
    });
    expect(toolbarGeometry.share).toEqual(toolbarGeometry.terminal);
    await shareButton.click();
    expect(await $("[data-testid=conversation-share-selection-panel]").isExisting()).toBe(false);
    // 回归原因：顶部入口原先只切换选择面板，再次点击没有退出分享。
    await $("[data-testid=conversation-share-selection-dock]").waitForDisplayed();
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-selection-dock]").waitForDisplayed({ reverse: true });
    expect(await $("[data-testid=conversation-share-trigger]").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(await $("[data-testid=conversation-share-selection-reopen]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-selection-dock]").waitForDisplayed();
    // 回归原因：固定标签宽度会拆开英文；窄面板应让按钮整组换行。
    const selectionLayout = await browser.execute(() => {
      const dock = document.querySelector<HTMLElement>(
        '[data-testid="conversation-share-selection-dock"]',
      )!;
      const label = dock.querySelector<HTMLElement>(
        '[data-testid="conversation-share-bulk-label"]',
      )!;
      const bulk = dock.querySelector<HTMLElement>(
        '[data-testid="conversation-share-bulk-actions"]',
      )!;
      const next = dock.querySelector<HTMLElement>('[data-testid="conversation-share-next"]')!;
      const originalText = label.textContent;
      const originalStyle = dock.getAttribute("style");
      label.textContent = "Deselect all";
      dock.style.width = "320px";
      const labelRect = label.getBoundingClientRect();
      const result = {
        singleLine: labelRect.height <= parseFloat(getComputedStyle(label).lineHeight) + 1,
        actionsBelow: next.getBoundingClientRect().top >= bulk.getBoundingClientRect().bottom,
        fits: dock.scrollWidth <= dock.clientWidth,
      };
      label.textContent = originalText;
      if (originalStyle === null) dock.removeAttribute("style");
      else dock.setAttribute("style", originalStyle);
      return result;
    });
    expect(selectionLayout).toEqual({ singleLine: true, actionsBelow: true, fits: true });
    const reopenSelectionButton = await $("[data-testid=conversation-share-selection-reopen]");
    await reopenSelectionButton.waitForClickable();
    await reopenSelectionButton.click();
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();
    const selectionItems = await $$('[data-conversation-share-selection-item="true"]');
    expect(selectionItems.length).toBeGreaterThan(1);
    const secondSelectionItem = selectionItems[1]!;
    await (
      await secondSelectionItem.$('[data-conversation-share-checkbox-hit-area="true"]')
    ).click();
    expect(
      await (
        await $$('[data-conversation-share-selection-item="true"]')
      )[1]!.getAttribute("data-conversation-share-selection-state"),
    ).toBe("unselected");
    await $("[data-testid=conversation-share-selection-scrim]").click();
    await browser.waitUntil(
      async () => !(await $("[data-testid=conversation-share-selection-panel]").isDisplayed()),
      { timeout: 5_000, timeoutMsg: "选择面板关闭后仍可见" },
    );
    await reopenSelectionButton.waitForClickable();
    await reopenSelectionButton.click();
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();
    expect(
      await (
        await $$('[data-conversation-share-selection-item="true"]')
      )[1]!.getAttribute("data-conversation-share-selection-state"),
    ).toBe("unselected");
    const nextButton = await $("[data-testid=conversation-share-next]");
    await nextButton.waitForClickable();
    await nextButton.click();
    const backButton = await $("[data-testid=conversation-share-back]");
    await backButton.waitForClickable();
    await backButton.click();
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();
    await nextButton.waitForClickable();
    await nextButton.click();
    const publicReadonly = await $('[data-conversation-share-permission="link-viewer"]');
    await publicReadonly.waitForClickable();
    await publicReadonly.click();
    const disclosureScopeTrigger = await $(
      "[data-testid=conversation-share-disclosure-scope-trigger]",
    );
    await disclosureScopeTrigger.waitForClickable();
    await disclosureScopeTrigger.click();
    const disclosureScope = await $("[data-testid=conversation-share-disclosure-scope-content]");
    await disclosureScope.waitForDisplayed();
    expect(await disclosureScope.getText()).toMatch(/检查范围|Review scope/iu);
    await disclosureScopeTrigger.click();
    await browser.waitUntil(async () => !(await disclosureScope.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: "关闭检查范围后浮层仍可见",
    });
    const publishButton = await $("[data-testid=conversation-share-confirm]");
    expect(await publishButton.isEnabled()).toBe(true);
    await publishButton.click();
    const reviewCheckbox = await $("[data-testid=conversation-share-disclosure-checkbox]");
    expect(await reviewCheckbox.isFocused()).toBe(true);
    expect(await $("[data-testid=conversation-share-review-hint]").isExisting()).toBe(false);
    await reviewCheckbox.click();
    // SHARE28：宽窗口内也可能只有极窄 Dock，不能用 viewport 断点代替容器宽度。
    const beforeNarrow = await browser.execute(() => {
      const dock = document.querySelector<HTMLElement>(
        '[data-testid="conversation-share-confirmation-dock"]',
      )!;
      const title = dock.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
      dock.style.width = "320px";
      return title.value;
    });
    try {
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const dock = document.querySelector<HTMLElement>(
              '[data-testid="conversation-share-confirmation-dock"]',
            )!;
            const bounds = dock.getBoundingClientRect();
            const buttons = [
              ...dock.querySelectorAll<HTMLElement>(
                '[data-testid="conversation-share-confirmation-actions"] button',
              ),
            ];
            const labels = [...dock.querySelectorAll<HTMLElement>('[role="radio"] span')];
            return (
              dock.scrollWidth <= dock.clientWidth + 1 &&
              buttons.every((button) => {
                const rect = button.getBoundingClientRect();
                return (
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.bottom <= window.innerHeight
                );
              }) &&
              labels.every((label) => label.scrollWidth <= label.clientWidth + 1)
            );
          }),
        { timeout: 5_000, timeoutMsg: "320px 分享 Dock 存在裁切" },
      );
      expect(await publicReadonly.getAttribute("aria-checked")).toBe("true");
      expect(await reviewCheckbox.isSelected()).toBe(true);
    } finally {
      await browser.execute(() => {
        document
          .querySelector<HTMLElement>('[data-testid="conversation-share-confirmation-dock"]')!
          .style.removeProperty("width");
      });
    }
    expect(
      await browser.execute(
        () =>
          document.querySelector<HTMLInputElement>(
            '[data-testid="conversation-share-confirmation-dock"] input:not([type="checkbox"])',
          )!.value,
      ),
    ).toBe(beforeNarrow);
    expect(await publicReadonly.getAttribute("aria-checked")).toBe("true");
    expect(await reviewCheckbox.isSelected()).toBe(true);
    await publishButton.waitForClickable();
    await publishButton.click();

    const copyButton = await $(`[data-testid="conversation-share-copy-link"]`);
    await copyButton.waitForDisplayed({ timeout: 120_000 });
    expect(await copyButton.getText()).toMatch(/复制链接|Copy link/iu);
    expect(await $(`[data-testid="conversation-share-open-browser"]`).isExisting()).toBe(true);
    expect((await $$('[data-testid="conversation-share-success-actions"] button')).length).toBe(2);
    expect(await $("[data-testid=conversation-share-selection-panel]").isDisplayed()).toBe(false);
    expect(await $("[data-testid=conversation-share-success-dock]").isDisplayed()).toBe(true);

    // SHARE27：分享成功态属于 Session A。切到新会话并完成一次独立分享选择时，
    // 不应把 A 的成功 dock 投影到 B；返回 A 后仍应恢复 A 的成功 dock。
    const sessionA = (
      await waitForChatState((snapshot) => snapshot.state === "idle", "读取 Session A 分享状态失败")
    ).sessionId;
    expect(sessionA).toBeTruthy();
    await startNewV4Draft();
    const sessionBMarker = `${CASE_MARKER}: session-b`;
    await sendPrompt(`${sessionBMarker}: reply with exactly share-session-b-ready`);
    await waitForAssistantMessageContaining("share-session-b-ready");
    const sessionB = (
      await waitForChatState(
        (snapshot) => snapshot.state === "idle",
        "Session B 分享前会话没有进入终态",
        90_000,
      )
    ).sessionId;
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await (await $("[data-testid=conversation-share-trigger]")).click();
    const sessionBReopenSelection = await $("[data-testid=conversation-share-selection-reopen]");
    if (!(await $("[data-testid=conversation-share-selection-panel]").isDisplayed())) {
      await sessionBReopenSelection.waitForClickable();
      await sessionBReopenSelection.click();
    }
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();
    const sessionBPreflightStatus = await $(
      "[data-testid=conversation-share-selection-preflight-status]",
    );
    await sessionBPreflightStatus.waitForDisplayed({ timeout: 30_000 });
    // 预检进度由状态入口展示，下一步不再重复展示等待图标或空占位。
    expect(await $("[data-testid=conversation-share-next]").getHTML()).not.toContain("<span");
    await browser.waitUntil(
      async () => (await sessionBPreflightStatus.getAttribute("aria-busy")) !== "true",
      { timeout: 30_000, timeoutMsg: "Session B 分享候选预检没有完成" },
    );
    await $("[data-testid=conversation-share-next]").waitForClickable();
    await $("[data-testid=conversation-share-next]").click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await selectV4TaskById(sessionA!);
    await $("[data-testid=conversation-share-success-dock]").waitForDisplayed();
    await $("[data-testid=conversation-share-success-dismiss]").click();
    await browser.waitUntil(
      async () => !(await $("[data-testid=conversation-share-success-dock]").isDisplayed()),
      { timeout: 5_000, timeoutMsg: "关闭 Session A 分享结果后仍可见" },
    );
    await selectV4TaskById(sessionB!);
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-cancel]").click();

    // 关闭成功结果后重新发布同一份草稿，验证重试仍复用完整幂等请求体，不因 accepted_at 变化返回 409。
    await selectV4TaskById(sessionA!);
    await browser.waitUntil(
      async () => !(await $(`[data-testid="conversation-share-success-dock"]`).isDisplayed()),
      { timeout: 5_000, timeoutMsg: "关闭分享成功结果后仍可见" },
    );
    const retryShareButton = await $("[data-testid=conversation-share-trigger]");
    await retryShareButton.waitForClickable();
    await retryShareButton.click();
    await $("[data-testid=conversation-share-selection-reopen]").click();
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();
    const retrySelectionItems = await $$('[data-conversation-share-selection-item="true"]');
    const retrySecondSelection = await retrySelectionItems[1]!.$(
      '[data-conversation-share-checkbox-hit-area="true"]',
    );
    await retrySecondSelection.click();
    await $("[data-testid=conversation-share-next]").click();
    await $('[data-conversation-share-permission="link-viewer"]').click();
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await $("[data-testid=conversation-share-confirm]").click();
    await copyButton.waitForDisplayed({ timeout: 120_000 });
  });

  it("SHARE25：选择阶段检查最终预览卡片，PDF 分享、视频 warning、正文路径不入候选", async function () {
    this.timeout(180_000);
    await prepareConversationE2E();
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await mkdir(PREVIEW_CASE_ROOT, { recursive: true });
    await writeFile(join(PREVIEW_CASE_ROOT, PREVIEW_PDF), "%PDF-1.4\n");
    for (const video of PREVIEW_VIDEOS) {
      await writeFile(join(PREVIEW_CASE_ROOT, video), "synthetic-video");
    }

    await sendPrompt(
      `${PREVIEW_CASE_MARKER}: reply with the prepared preview-card paths and the plain home path.`,
    );
    await waitForAssistantMessageContaining(PREVIEW_PDF);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "预览卡片分享前会话没有进入终态",
      90_000,
    );

    await (await $("[data-testid=conversation-share-trigger]")).click();
    const reopenSelectionButton = await $("[data-testid=conversation-share-selection-reopen]");
    const selectionPanel = await $("[data-testid=conversation-share-selection-panel]");
    if (!(await selectionPanel.isExisting()) || !(await selectionPanel.isDisplayed())) {
      await reopenSelectionButton.waitForClickable();
      await reopenSelectionButton.click();
    }
    await $("[data-testid=conversation-share-selection-panel]").waitForDisplayed();

    const preflightStatus = await $("[data-testid=conversation-share-selection-preflight-status]");
    await preflightStatus.waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(
      async () => (await preflightStatus.getAttribute("aria-busy")) !== "true",
      { timeout: 30_000, timeoutMsg: "分享候选预检没有完成" },
    );
    await preflightStatus.click();
    const preflightPopover = await $(
      "[data-testid=conversation-share-selection-preflight-popover]",
    );
    await preflightPopover.waitForDisplayed();
    const preflightText = await preflightPopover.getText();
    for (const video of PREVIEW_VIDEOS) expect(preflightText).toContain(video);
    expect(preflightText).not.toContain(PREVIEW_PDF);
    expect(preflightText).not.toContain("layout-review.md");
    expect(await $("[data-testid=conversation-share-next]").isEnabled()).toBe(true);

    await $("[data-testid=conversation-share-next]").click();
    const publicImportable = await $('[data-conversation-share-permission="link-editor"]');
    expect(await publicImportable.getAttribute("aria-checked")).toBe("true");
    expect(
      await (
        await $('[data-conversation-share-permission="private"]')
      ).getAttribute("aria-checked"),
    ).toBe("false");
    await $('[data-conversation-share-permission="link-viewer"]').click();
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await $("[data-testid=conversation-share-confirm]").click();

    const successDock = await $("[data-testid=conversation-share-success-dock]");
    await successDock.waitForDisplayed({ timeout: 120_000 });
    const successWarning = await successDock.$("[data-testid=conversation-share-success-warning]");
    await successWarning.waitForDisplayed();
    await successWarning.$("summary").click();
    const successText = await successDock.getText();
    for (const video of PREVIEW_VIDEOS) expect(successText).toContain(video);
    expect(successText).not.toContain("layout-review.md");
  });

  it("SHARE18/SHARE-E2E-03 unsupported structure is shown before next step", async function () {
    this.timeout(150_000);
    await prepareConversationE2E();
    await sendPrompt(
      "E2E_CONVERSATION_SHARE_ERROR_V1: reply exactly with file:///workspace/not-shareable.pdf",
    );
    await waitForAssistantMessageContaining("file:///workspace/not-shareable.pdf");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "错误提示前会话没有进入终态",
      90_000,
    );

    await (await $(`[data-testid="conversation-share-trigger"]`)).click();
    const details = await $(`[data-testid="conversation-share-selection-preflight-blocked"]`);
    await details.waitForDisplayed({ timeout: 30_000 });
    expect(await details.getText()).toMatch(/本地|local/iu);
    expect(await details.getText()).toMatch(/取消选择|deselect/iu);
    expect(await (await $(`[data-testid="conversation-share-next"]`)).isEnabled()).toBe(false);
    expect((await getToastMessages()).join("\n")).not.toMatch(
      /生成分享链接失败|Could not generate the share link/iu,
    );
  });
});
