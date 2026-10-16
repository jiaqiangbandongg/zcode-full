# 问题上报自动截图设计

## 背景

顶部帮助菜单里的“问题上报”当前只打开通用“提交反馈”弹窗，不会自动带上用户当时看到的任务现场。任务右键反馈、Header 更多菜单里的任务反馈、远程连接失败反馈已经通过 `IPlatformService.captureWindowScreenshot()` 截取当前 Electron 窗口，并把结果作为 `FeedbackSubmitDraft.screenshots` 传给反馈表单。

本需求要求用户点击帮助菜单里的“问题上报”后，自动把当前窗口任务截图放入“提交反馈”弹窗的截图区域。

## 目标

- 点击帮助菜单“问题上报”时，先截取当前窗口当前画面，再打开“提交反馈”弹窗。
- 截图应出现在反馈表单已有“截图”区域中，数量计数和删除能力复用现有 `FeedbackScreenshotPicker`。
- 截图目标是不包含即将打开的反馈弹窗的当前窗口任务现场。
- 桌面端使用已有 Electron 平台截图能力；Web、手机 Web 或截图失败时正常打开反馈弹窗，但不附带截图。
- 不改变“给产品提需求”“用户社群”“产品文档”“导出日志”等菜单项行为。

## 非目标

- 不新增截图编辑、裁剪、标注能力。
- 不改变反馈提交上传协议、工单字段或日志上传逻辑。
- 不修改远控 relay、main 进程、session/task stream、snapshot、queue、replayable 恢复语义。
- 不把截图能力下沉到服务层或远控业务状态中。

## 现有实现依据

- `packages/shared/src/platform.ts` 已定义 `captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>`，注释明确 Web fallback 可返回 `null`。
- `packages/desktop/src/main/desktopMainIpcPlatform.ts` 已通过 `BrowserWindow.fromWebContents(event.sender).webContents.capturePage()` 截取当前窗口。
- `packages/desktop/src/preload/index.ts` 和 `packages/desktop/src/renderer/src/main.tsx` 已把 `captureWindowScreenshot` 暴露给 UI 平台服务。
- `packages/ui/src/WorkspaceHelpMenuButton.tsx` 是截图中帮助菜单入口所在组件，当前 `handleOpenIssueReport` 只调用 `openFeedbackSubmit(...)`。
- `packages/ui/src/feedback/FeedbackSubmitForm.tsx` 已支持从 `initialDraft.screenshots` 初始化截图区域。

## 设计

### 入口行为

`WorkspaceHelpMenuButton` 的“问题上报”菜单项改为异步处理：

1. 用户点击菜单项。
2. UI 调用安全截图 helper。
3. helper 调用 `platform.captureWindowScreenshot?.()`。
4. helper 将成功结果转换为 `FeedbackAttachmentDraft[]`；无能力、返回 `null` 或抛错时返回空数组。
5. UI 调用 `openFeedbackSubmit({ type: "bug", module: "其它", severity: "P2-中", includeLogs: true, screenshots })`。

截图调用发生在 `openFeedbackSubmit` 之前，因此 Electron 截到的是当前任务窗口，不包含反馈弹窗自身。

### Helper 边界

新增一个小型 UI helper，例如 `packages/ui/src/feedback/feedbackScreenshotDraft.ts`：

```ts
import type { IPlatformService } from "@zcode/shared";
import type { FeedbackAttachmentDraft } from "@/feedback/feedbackStore.js";

export async function captureFeedbackScreenshotDraft(
  platform: Pick<IPlatformService, "captureWindowScreenshot">,
): Promise<FeedbackAttachmentDraft[]> {
  const screenshot = await platform.captureWindowScreenshot?.().catch(() => null);
  return screenshot ? [screenshot] : [];
}
```

这个 helper 只处理 UI draft 组装，不做日志、不弹 toast、不重试。截图失败通常不是用户提交反馈的主流程错误，静默降级可以保证反馈弹窗仍然打开。

### 兼容性

- 桌面端：复用已有 IPC 截图能力。
- Web 端：`captureWindowScreenshot` 可不存在或返回 `null`，反馈弹窗仍打开。
- 手机远控：不新增独立 runtime、host 或远控状态；只在当前 UI 入口读取平台可选能力，保持 replayable/continuous 链路边界不变。
- 主题和国际化：不新增可见文案，不改样式；反馈弹窗继续使用现有组件和 i18n 文案。

## 测试

- 为 `captureFeedbackScreenshotDraft` 添加单元测试：
  - 截图成功时返回包含一张 `FeedbackAttachmentDraft` 的数组。
  - `captureWindowScreenshot` 返回 `null` 时返回空数组。
  - `captureWindowScreenshot` 抛错时返回空数组。
- 为 `WorkspaceHelpMenuButton` 添加或更新组件测试：
  - 点击“问题上报”后，先等待截图 Promise，再调用 feedback store 的 `openSubmit`，draft 中包含截图。
  - 截图失败时仍调用 `openSubmit`，draft 中 `screenshots` 为空数组。
- 全量机械校验：
  - `pnpm typecheck`
  - `pnpm lint`

## 风险与回归点

- 如果截图 Promise 变慢，反馈弹窗会延后打开。当前截图是本地窗口捕获，预期耗时很短；如后续需要优化，可改为先打开弹窗并显示截图加载态，但那会扩大反馈表单影响面。
- 如果 Electron 截图失败，用户仍能提交文字和日志，行为降级可接受。
- 本改动不触碰反馈上传链路，因此不会改变截图上传的文件格式、大小限制和 6 张上限。
