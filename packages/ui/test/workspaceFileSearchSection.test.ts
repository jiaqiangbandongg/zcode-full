import type { IFileService } from "@zcode/services";
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

  it("keeps the save action gated on editable-or-dirty state in source contract", () => {
    const source = readFileSync(
      new URL("../src/settings/WorkspaceFileSearchSection.tsx", import.meta.url),
      "utf8",
    );

    // 保存语义是"落盘编辑框内容"：template 态（文件未创建）即使未编辑也可保存，
    // 用户第一次进页面不改任何内容也能创建 .zcodeignore；已落盘态才有修改才可保存。
    expect(source).toContain(
      'const canSave = loaded === null || loaded.source === "template" || draft !== loaded.content;',
    );
    expect(source).toContain("disabled={!canSave || saving || loading}");
    // "未保存修改"提示仍只表达真实差异，template 态未编辑时不显示。
    expect(source).toContain(
      'const dirty = loaded !== null && loaded.source === "file" && draft !== loaded.content;',
    );
  });

  it("matches the fileService RPC surface used by the section", () => {
    // IFileService 契约快照：section 依赖的两个方法必须存在于服务接口，
    // 防止未来接口重命名悄悄断开设置页。
    const fileServiceKeys: Array<keyof IFileService> = [
      "readWorkspaceFileSearchIgnore",
      "writeWorkspaceFileSearchIgnore",
    ];
    expect(fileServiceKeys.every((key) => typeof key === "string")).toBe(true);
  });
});
