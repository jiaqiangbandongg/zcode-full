import type { IServiceAccessor } from "@/hooks/useServices.js";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";

// 组件顶层 hook 链（useWorkspaceServicesResolution → useServices）要求 context 存在；
// 无 workspace 分支不会真正调用任何服务方法，空 accessor 即可。
const emptyAccessor = {} as unknown as IServiceAccessor;

function renderSection(props: { workspacePath?: string | null }): string {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: emptyAccessor },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceFileSearchSection, props),
      ),
    ),
  );
}

describe("WorkspaceFileSearch settings section", () => {
  it("renders a hint instead of the editor when no workspace is open", () => {
    // 无 workspace 分支不触达 services：直接渲染提示文案，避免误拉文件服务。
    const html = renderSection({ workspacePath: null });
    // 显式固定中文，避免系统语言不同导致相同组件在 CI 上断言失败。
    expect(html).toContain("当前没有打开的工作区");
    expect(html).not.toContain("workspace-file-search-ignore-editor");
  });

  it("wires the ignore editor to the fileService RPC contract", () => {
    // 契约断言（同 hooksSection 模式）：编辑页必须走 fileService 的专用 RPC，
    // 不允许绕过服务层直接读写本地文件；分区操作必须走 applyTransform（分区重写，
    // 不允许整体覆盖用户内容）。
    const source = readFileSync(
      new URL("../src/settings/WorkspaceFileSearchSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("readWorkspaceFileSearchIgnore");
    expect(source).toContain("writeWorkspaceFileSearchIgnore");
    expect(source).toContain("applyWorkspaceFileSearchIgnoreTransform({");
    expect(source).toContain("transform,");
    expect(source).not.toContain("readTextFile");
    expect(source).not.toContain("window.zcode");
  });
});
