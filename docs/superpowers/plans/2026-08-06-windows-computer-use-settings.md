# Windows 电脑控制设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 桌面设置页显示「电脑控制」分区，并只提供与 macOS 共用的官方 `zcode-cua` 插件总开关。

**Architecture:** 设置页配置改为按明确的 `isMacDesktop` / `isWindowsDesktop` props 生成，避免 Web 端依赖 user agent 误露出桌面能力。`ComputerUseSection` 保留共享插件开关流程，同时把本地 Windows 的“开关能力”与仅限 macOS 的权限、Helper 和附加设置能力分开。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、Tailwind CSS

## Global Constraints

- Windows 与 macOS 必须复用 `ZCODE_CUA_OFFICIAL_PLUGIN_ID`、插件 store 和 `setEnabled` 流程。
- Windows 只显示总开关，不显示画中画、后台模式、Helper 状态或授权相关内容。
- macOS 现有完整设置和权限能力判断保持不变。
- Linux、普通 Web、手机远控和远程 workspace 不开放该本地设置能力。
- UI 继续复用 `SettingsGroupCard`、`SettingsRow`、`Switch` 和既有国际化文案。
- 不新增协议、设置字段、runtime、local host 或远程控制状态。
- 所有实现代码前先写测试并确认测试按预期失败。
- 完成前必须执行 `pnpm typecheck` 与 `pnpm lint`。

---

## File Structure

- Modify: `packages/ui/src/settings/settingsPageConfig.ts` — 按桌面平台生成可见分区，并解析平台可见的导航落点。
- Modify: `packages/ui/src/settingsPageHelpers.tsx` — 向设置页重导出平台配置函数。
- Modify: `packages/ui/src/SettingsPage.tsx` — 使用平台配置、保护初始落点和导航意图，并把 Windows 标记传给电脑控制分区。
- Modify: `packages/ui/test/settingsPageConfig.test.ts` — 覆盖 macOS、Windows、非桌面端的分区和不可见落点回退。
- Modify: `packages/ui/test/settingsPageIntegratedTerminalShell.test.ts` — 让既有 SettingsPage 测试 mock 提供新的配置函数接口。
- Modify: `packages/ui/src/settings/ComputerUseSection.tsx` — Windows 复用总开关，macOS 独占附加设置与权限副作用。
- Create: `packages/ui/test/computerUseWindowsSettings.test.ts` — 渲染级验证 Windows 只有总开关且调用共享插件启停流程。

---

### Task 1: 平台感知的设置分区配置

**Files:**

- Modify: `packages/ui/test/settingsPageConfig.test.ts`
- Modify: `packages/ui/src/settings/settingsPageConfig.ts`

**Interfaces:**

- Produces: `createSettingsPageConfig(options: { isMacDesktop?: boolean; isWindowsDesktop?: boolean })`
- Produces: `resolveSettingsSectionForPlatform(section, visibleSections, fallbackSection?)`
- Returns: `{ settingsSections, settingsSectionGroups }`

- [ ] **Step 1: 写平台配置和落点回退的失败测试**

在 `packages/ui/test/settingsPageConfig.test.ts` 中改为通过工厂读取配置，并加入以下断言：

```ts
it.each([
  ["macOS", { isMacDesktop: true }, true],
  ["Windows", { isWindowsDesktop: true }, true],
  ["Web/Linux", {}, false],
] as const)("%s 的电脑控制入口符合桌面平台边界", async (_name, options, expected) => {
  const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
  const { settingsSections } = createSettingsPageConfig(options);

  expect(settingsSections.some((section) => section.id === "computerUse")).toBe(expected);
});

it("不可见的电脑控制落点回退到 general", async () => {
  const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
    await loadSettingsPageConfig("test");
  const { settingsSections } = createSettingsPageConfig({});

  expect(resolveSettingsSectionForPlatform("computerUse", settingsSections, "general")).toBe(
    "general",
  );
});
```

同步把既有顺序测试改为调用 `createSettingsPageConfig({})`，其非桌面端预期顺序保持不含
`computerUse`。

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```powershell
pnpm exec vitest run packages/ui/test/settingsPageConfig.test.ts
```

Expected: FAIL，提示 `createSettingsPageConfig` 或 `resolveSettingsSectionForPlatform` 尚未导出。

- [ ] **Step 3: 实现最小的平台配置工厂**

在 `packages/ui/src/settings/settingsPageConfig.ts` 中删除 `IS_MACOS_DESKTOP` 依赖，并实现：

```ts
export interface SettingsPageConfigOptions {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}
```

- [ ] **Step 4: 运行配置测试并确认绿灯**

Run:

```powershell
pnpm exec vitest run packages/ui/test/settingsPageConfig.test.ts
```

Expected: PASS，所有设置顺序、平台入口和落点回退断言通过。

---

### Task 2: SettingsPage 使用平台配置并安全路由

**Files:**

- Modify: `packages/ui/src/settingsPageHelpers.tsx`
- Modify: `packages/ui/src/SettingsPage.tsx`
- Modify: `packages/ui/test/settingsPageIntegratedTerminalShell.test.ts`
- Test: `packages/ui/test/settingsPageConfig.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `createSettingsPageConfig` 和 `resolveSettingsSectionForPlatform`
- Produces: SettingsPage 当前平台唯一的 `settingsSections` / `settingsSectionGroups`
- Produces: `ComputerUseSection.isWindowsDesktop`

- [ ] **Step 1: 扩展既有 SettingsPage 测试 mock，先暴露新接口缺口**

把 `packages/ui/test/settingsPageIntegratedTerminalShell.test.ts` 的
`settingsPageHelpers.js` mock 改为返回固定配置的工厂：

```ts
const settingsSections = [
  {
    id: "general",
    titleId: "settings.general",
    navLabelId: "settings.general",
    icon: () => null,
  },
];
const settingsSectionGroups = [
  {
    id: "basics",
    titleId: "settings.general",
    sections: settingsSections,
  },
];

vi.mock("../src/settingsPageHelpers.js", () => ({
  createSettingsPageConfig: () => ({ settingsSectionGroups, settingsSections }),
  resolveSettingsSectionForPlatform: (section: string) => section,
  GeneralSectionContent: (props: Record<string, unknown>) => {
    generalSectionCapture.props = props;
    return createElement("div", null, "general");
  },
  GeneralSectionHeader: () => null,
}));
```

在真实 `settingsPageHelpers.tsx` 尚未重导出新接口时运行测试，确认 SettingsPage 切换接口前测试
环境仍能明确暴露导出不匹配。

- [ ] **Step 2: 在 helper 层重导出平台配置函数**

在 `packages/ui/src/settingsPageHelpers.tsx` 中改为：

```ts
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";

export type { SettingsSectionId };
export { createSettingsPageConfig, resolveSettingsSectionForPlatform };
```

- [ ] **Step 3: SettingsPage 生成当前平台配置并保护初始落点**

在 `packages/ui/src/SettingsPage.tsx` 的组件开头生成配置：

```ts
const { settingsSectionGroups, settingsSections } = useMemo(
  () =>
    createSettingsPageConfig({
      isMacDesktop: Boolean(isMacDesktop),
      isWindowsDesktop: Boolean(isWindowsDesktop),
    }),
  [isMacDesktop, isWindowsDesktop],
);
```

初始化 `activeSection` 时通过平台可见性解析：

```ts
const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
  const initialSection = resolveSettingsSectionForPlatform(
    consumeInitialSettingsSection("general"),
    settingsSections,
    "general",
  );
  writeLastSettingsSectionPreference(initialSection);
  return initialSection;
});
```

更新导航回调，确保运行时 intent 也不能跳到不可见页面：

```ts
const setActiveSettingsSection = useCallback(
  (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
    const globallyResolved = resolveSettingsSection(section, fallbackSection);
    const resolvedSection = resolveSettingsSectionForPlatform(
      globallyResolved,
      settingsSections,
      fallbackSection,
    );
    setActiveSection(resolvedSection);
    writeLastSettingsSectionPreference(resolvedSection);
  },
  [activeSection, settingsSections],
);
```

把侧栏和 active meta 分别改为使用 `settingsSectionGroups`、`settingsSections`，并向组件传递：

```tsx
<ComputerUseSection
  isWindowsDesktop={Boolean(isWindowsDesktop)}
  workspacePath={activeWorkspacePath}
  workspaceIdentity={activeWorkspaceIdentity}
  remoteSessionId={activeWorkspaceTab?.remoteSessionId}
  remoteTarget={activeWorkspaceTab?.remoteTarget}
  localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
/>
```

- [ ] **Step 4: 运行 SettingsPage 相关测试**

Run:

```powershell
pnpm exec vitest run packages/ui/test/settingsPageConfig.test.ts packages/ui/test/settingsPageIntegratedTerminalShell.test.ts
```

Expected: PASS；平台配置顺序、不可见落点回退和既有 Windows 终端设置测试均通过。

---

### Task 3: Windows 只渲染共享总开关

**Files:**

- Create: `packages/ui/test/computerUseWindowsSettings.test.ts`
- Modify: `packages/ui/src/settings/ComputerUseSection.tsx`

**Interfaces:**

- Consumes: `ComputerUseSectionProps.isWindowsDesktop?: boolean`
- Consumes: `ZCODE_CUA_OFFICIAL_PLUGIN_ID`
- Preserves: `usePluginManagementStore.setEnabled(pluginId, next, pluginManagementService)`

- [ ] **Step 1: 写 Windows 渲染和开关行为的失败测试**

新建 `packages/ui/test/computerUseWindowsSettings.test.ts`，mock 平台、服务、权限 hook、设置
hook、国际化和插件 store。核心用例为：

```tsx
it("Windows 只展示共享总开关", () => {
  render(
    <ComputerUseSection
      isWindowsDesktop
      workspacePath="C:\\workspace"
      workspaceIdentity="local-workspace"
    />,
  );

  expect(screen.getByText("settings.computerUse.toggleLabel")).toBeTruthy();
  expect(screen.queryByText("settings.computerUse.pipModeLabel")).toBeNull();
  expect(screen.queryByText("settings.computerUse.backgroundModeLabel")).toBeNull();
  expect(screen.queryByText("settings.computerUse.helperLabel")).toBeNull();
  expect(screen.queryByText("cuaPermission.perm.accessibility")).toBeNull();
  expect(screen.queryByText("cuaPermission.perm.screenRecording")).toBeNull();
});

it("Windows 总开关复用官方 zcode-cua 启停流程", async () => {
  render(
    <ComputerUseSection
      isWindowsDesktop
      workspacePath="C:\\workspace"
      workspaceIdentity="local-workspace"
    />,
  );

  fireEvent.click(screen.getByRole("switch", { name: "settings.computerUse.toggleLabel" }));

  await waitFor(() => {
    expect(setEnabled).toHaveBeenCalledWith(
      ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      false,
      pluginManagementService,
    );
  });
});
```

另加 macOS 回归用例，确认插件已启用时仍渲染 PiP、后台模式和两项权限行。

- [ ] **Step 2: 运行新测试并确认红灯**

Run:

```powershell
pnpm exec vitest run packages/ui/test/computerUseWindowsSettings.test.ts
```

Expected: FAIL；当前组件没有 `isWindowsDesktop` 能力并会被 macOS-only 门禁整体隐藏。

- [ ] **Step 3: 拆分本地平台能力并渲染最小 Windows UI**

在 `ComputerUseSectionProps` 增加：

```ts
isWindowsDesktop?: boolean;
```

在组件中拆分平台边界：

```ts
const isLocalWorkspace =
  !remoteSessionId &&
  !remoteTarget &&
  !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
const supportsLocalMacWorkspace =
  !isWindowsDesktop && supportsLocalMacCuaPermissionOnboarding(platform) && isLocalWorkspace;
const supportsLocalWindowsWorkspace = Boolean(isWindowsDesktop) && isLocalWorkspace;
const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
const path = supportsLocalMacWorkspace ? (localWorkspacePath ?? workspacePath) : null;
```

插件初始化 effect 改用 `supportsComputerUseSettings`，组件返回门禁也使用同一变量。给总开关增加
已有文案作为可访问名称：

```tsx
<Switch
  aria-label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
  checked={cuaEnabled}
  disabled={cuaToggling || !workspacePath}
  onCheckedChange={(checked) => void onTogglePlugin(checked)}
/>
```

macOS 附加内容只在以下条件渲染：

```tsx
{
  cuaEnabled && supportsLocalMacWorkspace ? (
    <>{/* 保留现有 PiP、后台模式、Helper 和权限内容 */}</>
  ) : null;
}
```

插件切换成功后只在 `supportsLocalMacWorkspace` 时刷新权限与 Helper 展示状态；Windows 仅依赖
共享插件 store 确认新状态。

- [ ] **Step 4: 运行新测试并确认绿灯**

Run:

```powershell
pnpm exec vitest run packages/ui/test/computerUseWindowsSettings.test.ts
```

Expected: PASS；Windows 仅有总开关、共享启停调用正确、macOS 附加设置仍存在。

---

### Task 4: 回归验证、审查与提交

**Files:**

- Verify: `docs/superpowers/specs/2026-08-06-windows-computer-use-settings-design.md`
- Verify: Task 1–3 的全部代码与测试文件

**Interfaces:**

- Consumes: 所有前置任务结果
- Produces: 一个通过仓库门禁的 Conventional Commit

- [ ] **Step 1: 运行聚焦回归测试**

Run:

```powershell
pnpm exec vitest run packages/ui/test/settingsPageConfig.test.ts packages/ui/test/settingsPageIntegratedTerminalShell.test.ts packages/ui/test/computerUseWindowsSettings.test.ts packages/ui/test/computerUseNoAutoPermissionModal.test.ts
```

Expected: PASS，四个测试文件零失败。

- [ ] **Step 2: 运行受影响测试**

Run:

```powershell
pnpm test:unit:affected
```

Expected: PASS；如果发现与本改动无关的分支既有失败，记录测试名和证据，不得忽略本改动相关失败。

- [ ] **Step 3: 执行强制类型和静态检查**

Run:

```powershell
pnpm typecheck
pnpm lint
```

Expected: 两个命令都以 exit code 0 完成。

- [ ] **Step 4: 检查 diff、平台边界和文档一致性**

Run:

```powershell
git diff --check
git diff --stat
git status --short
```

逐项确认：Windows 只有共享总开关；macOS 附加设置保留；非桌面端不显示入口；远程 workspace
仍被拒绝；没有修改协议、runtime 或远控状态。

- [ ] **Step 5: 请求代码审查并修复 Critical/Important 问题**

审查范围从设计 spec 提交后的基线到当前工作树，重点检查平台配置是否会让 Web 端误露出入口、
Windows 是否触发 macOS 权限副作用，以及插件启停是否仍使用官方 plugin id。

- [ ] **Step 6: 提交实现**

```powershell
git add -- packages/ui/src/settings/settingsPageConfig.ts packages/ui/src/settingsPageHelpers.tsx packages/ui/src/SettingsPage.tsx packages/ui/src/settings/ComputerUseSection.tsx packages/ui/test/settingsPageConfig.test.ts packages/ui/test/settingsPageIntegratedTerminalShell.test.ts packages/ui/test/computerUseWindowsSettings.test.ts docs/superpowers/plans/2026-08-06-windows-computer-use-settings.md
git commit -m "feat(cua): add Windows computer control setting"
```

Expected: Conventional Commit 创建成功，且不包含 `.pnpm-store/`、`.tmp/` 或其他无关文件。
