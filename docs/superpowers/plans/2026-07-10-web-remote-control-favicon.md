# Web Remote Control Favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在手机和桌面浏览器的 Web Remote Control 标签页显示与桌面 App 一致的 ZCode 图标。

**Architecture:** 将桌面端现有多尺寸 ICO 原样复制到 Web 的 Vite `public` 目录，保留传统 `/favicon.ico` 兼容路径；同时在 HTML 入口内嵌现有 App 32x32 PNG data URL favicon，让浏览器在解析入口 HTML 时即可拿到标签图标。回归测试同时约束 HTML metadata、PNG data URL 来源和两端图标二进制一致性，构建验证覆盖非根部署前缀下的 data URL 稳定性。

**Tech Stack:** Vite 8、HTML、Vitest 4、Node.js 24

## Global Constraints

- 直接复用 `packages/desktop/build/icon.ico`，不重新设计品牌资产。
- 不增加 PWA manifest、Apple Touch Icon 或 Android 主屏幕图标。
- 不修改页面标题、启动页、主题或其他 UI。
- 不改变桌面端 continuous 链路、手机端 replayable 链路或任何远控业务状态。
- 使用普通文件而不是符号链接，保持 Windows、macOS 和 Linux 兼容。
- Web Remote Control 必须兼容 `/remote/`、`/remote/v3/` 和 `/remote/__test__/` 部署前缀。

---

### Task 1: 添加并验证 Web favicon

**Files:**
- Modify: `packages/web/test/webRemoteControlBootstrapShell.test.ts`
- Create: `packages/web/public/favicon.ico`
- Modify: `packages/web/index.html`
- Modify: `docs/superpowers/specs/2026-07-10-web-remote-control-favicon-design.md`

**Interfaces:**
- Consumes: `public/logo/icons/32x32.png` 小尺寸 App 图标和 `packages/desktop/build/icon.ico` 品牌资产。
- Produces: base 无关的 `<link rel="icon" type="image/png" href="data:image/png;base64,..." sizes="32x32">` metadata，以及构建后进入 `dist` 的传统 `favicon.ico` 静态文件。

- [x] **Step 1: 写出失败的回归测试**

在 `packages/web/test/webRemoteControlBootstrapShell.test.ts` 中增加二进制读取 helper 和测试：

```ts
function readWorkspaceFile(path: string): Buffer {
  return readFileSync(resolve(process.cwd(), path));
}

function readWorkspaceFileDataUrl(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readWorkspaceFile(path).toString("base64")}`;
}

it("内嵌与桌面 App 同源的浏览器标签图标", () => {
  const html = readWebIndexHtml();

  expect(html).toContain(
    `<link rel="icon" type="image/png" href="${readWorkspaceFileDataUrl(
      "public/logo/icons/32x32.png",
      "image/png",
    )}" sizes="32x32" />`,
  );
  expect(readWorkspaceFile("packages/web/public/favicon.ico")).toEqual(
    readWorkspaceFile("packages/desktop/build/icon.ico"),
  );
  expect(readWorkspaceFile("public/logo/icons/icon.ico")).toEqual(
    readWorkspaceFile("packages/desktop/build/icon.ico"),
  );
});
```

- [x] **Step 2: 运行测试并确认按预期失败**

Run: `pnpm exec vitest run packages/web/test/webRemoteControlBootstrapShell.test.ts`

Expected: FAIL；失败原因是 HTML 尚未内嵌 App 32x32 PNG data URL favicon。

- [x] **Step 3: 添加最小实现**

在 `packages/web/index.html` 的 viewport metadata 后增加基于 `public/logo/icons/32x32.png` 生成的 data URL favicon：

```html
<link rel="icon" type="image/png" href="data:image/png;base64,..." sizes="32x32" />
```

继续将 `packages/desktop/build/icon.ico` 原样复制为 `packages/web/public/favicon.ico`，保留传统 favicon 路径兼容。使用文件复制命令不会改写二进制内容：

```bash
cp packages/desktop/build/icon.ico packages/web/public/favicon.ico
```

- [x] **Step 4: 运行定向测试并确认通过**

Run: `pnpm exec vitest run packages/web/test/webRemoteControlBootstrapShell.test.ts`

Expected: PASS，2 tests passed。

- [x] **Step 5: 验证非根部署路径构建结果**

Run: `pnpm run build:web-remote-control:test`

Expected: exit 0；`packages/web/dist/index.html` 保留 `data:image/png;base64,` favicon，且存在 `packages/web/dist/favicon.ico`。随后运行：

```bash
rg -n 'rel="icon" type="image/png" href="data:image/png;base64,' packages/web/dist/index.html
cmp packages/web/dist/favicon.ico packages/desktop/build/icon.ico
```

Expected: `rg` 输出匹配行，`cmp` exit 0。

- [x] **Step 6: 执行仓库强制验证**

Run: `pnpm typecheck`

Expected: exit 0，无 TypeScript 错误。

Run: `pnpm lint`

Expected: exit 0，无 lint 错误。

- [x] **Step 7: 检查改动并提交**

Run: `git diff --check && git status --short`

Expected: `git diff --check` exit 0；状态只包含 favicon 实现、测试、spec 修正和本计划。

```bash
git add packages/web/index.html packages/web/public/favicon.ico packages/web/test/webRemoteControlBootstrapShell.test.ts docs/superpowers/specs/2026-07-10-web-remote-control-favicon-design.md docs/superpowers/plans/2026-07-10-web-remote-control-favicon.md
git commit -m "fix(web): add remote control favicon"
```
