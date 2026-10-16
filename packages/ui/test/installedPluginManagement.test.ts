import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { InstalledPluginDetailPanel } from "../src/settings/InstalledPluginManagement.js";

describe("InstalledPluginDetailPanel", () => {
  it("renders plugin hook event, matcher, and command details", () => {
    const plugin: ZCodePluginInfo = {
      id: "ralph-loop@claude-plugins-official",
      name: "ralph-loop",
      enabled: true,
      source: "cache",
      marketplace: "claude-plugins-official",
      skillCount: 0,
      skillRootCount: 0,
      commandRootCount: 1,
      declaredMcpServerNames: [],
      mcpServerNames: [],
      hookDetails: [
        {
          event: "Stop",
          type: "command",
          command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh"',
          sourcePath: "/cache/ralph-loop/hooks/hooks.json",
          runnable: true,
        },
      ],
      rootPath: "/cache/ralph-loop",
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(InstalledPluginDetailPanel, {
          getPluginOptionValue: (
            _plugin: ZCodePluginInfo,
            _key: string,
            option: ZCodePluginUserConfigOption,
          ) => option.default ?? "",
          onSavePluginOptions: () => {},
          operationId: null,
          plugin,
          renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
          setPluginOptionDraft: () => {},
        }),
      ),
    );

    expect(html).toContain("Stop");
    expect(html).toContain("stop-hook.sh");
    expect(html).toContain("可运行");
    expect(html).not.toContain("暂未暴露 Hook 明细");
  });

  it("renders authoritative skill component names for both enabled and disabled plugins", () => {
    // 复现反馈中的 superpowers（14 个技能）。components 由 CLI 权威枚举随 list 下发，
    // 与启用态无关：启用/停用都应展示具体技能名，而不只是数量、也不应整组消失。
    const skillItems = Array.from({ length: 14 }, (_, index) => ({
      name: `superpowers-skill-${index + 1}`,
      ...(index === 0 ? { description: "Brainstorming ideas into designs" } : {}),
    }));

    for (const enabled of [true, false]) {
      const plugin: ZCodePluginInfo = {
        id: "superpowers@zcode-plugins-official",
        name: "superpowers",
        version: "5.1.0",
        enabled,
        source: "official",
        marketplace: "zcode-plugins-official",
        // 停用时 CLI 的 skillCount 为 0，但 components 仍完整。
        skillCount: enabled ? 14 : 0,
        skillRootCount: enabled ? 1 : 0,
        commandRootCount: 0,
        declaredMcpServerNames: [],
        mcpServerNames: [],
        hookDetails: [],
        rootPath: "/cache/superpowers",
        components: [{ kind: "skill", items: skillItems }],
      };

      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(InstalledPluginDetailPanel, {
            getPluginOptionValue: (
              _plugin: ZCodePluginInfo,
              _key: string,
              option: ZCodePluginUserConfigOption,
            ) => option.default ?? "",
            onSavePluginOptions: () => {},
            operationId: null,
            plugin,
            renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
            setPluginOptionDraft: () => {},
          }),
        ),
      );

      // 数量徽标 + 首尾技能名都应可见。
      expect(html).toContain("14");
      expect(html).toContain("superpowers-skill-1");
      expect(html).toContain("superpowers-skill-14");
      expect(html).toContain("Brainstorming ideas into designs");
      // 不应再落到「启用后查看组件」的空态。
      expect(html).not.toContain("启用插件后查看其组件。");
    }
  });

  it("renders warning diagnostics scoped to the plugin and hides them when none match", () => {
    // Bugfix（静默失败）回归：声明的技能路径扫描为空等 warning 此前在 UI 无渲染位置。
    const plugin: ZCodePluginInfo = {
      id: "mattpocock-skills@claude-plugins-official",
      name: "mattpocock-skills",
      enabled: true,
      source: "cache",
      marketplace: "claude-plugins-official",
      skillCount: 0,
      skillRootCount: 25,
      commandRootCount: 0,
      declaredMcpServerNames: [],
      mcpServerNames: [],
      hookDetails: [],
      rootPath: "/cache/mattpocock-skills",
      components: [],
    };

    const renderPanel = (diagnostics: ZCodePluginDiagnostic[]) =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(InstalledPluginDetailPanel, {
            diagnostics,
            getPluginOptionValue: (
              _plugin: ZCodePluginInfo,
              _key: string,
              option: ZCodePluginUserConfigOption,
            ) => option.default ?? "",
            onSavePluginOptions: () => {},
            operationId: null,
            plugin,
            renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
            setPluginOptionDraft: () => {},
          }),
        ),
      );

    // 只有当前插件自身的 warning 才展示；其他插件 / error 级别不进入列表。
    const withWarnings = renderPanel([
      {
        code: "plugin_skill_root_empty",
        message: "Plugin skills path does not contain any skills: ./skills/engineering/tdd",
        pluginId: "mattpocock-skills@claude-plugins-official",
        severity: "warning",
      },
      {
        code: "plugin_skill_root_empty",
        message: "Plugin skills path does not contain any skills: ./other",
        pluginId: "other-plugin@claude-plugins-official",
        severity: "warning",
      },
      {
        code: "plugin_manifest_invalid",
        message: "boom",
        pluginId: "mattpocock-skills@claude-plugins-official",
        severity: "error",
      },
    ]);
    expect(withWarnings).toContain("警告");
    expect(withWarnings).toContain("./skills/engineering/tdd");
    expect(withWarnings).not.toContain("./other");
    expect(withWarnings).not.toContain("boom");

    // 无匹配 warning 时不渲染空区块。
    expect(renderPanel([])).not.toContain("警告");
  });

  it("renders a details empty state for a plugin that declares no components", () => {
    // 真正无组件的插件给出诚实空态，不留白。
    const plugin: ZCodePluginInfo = {
      id: "empty-plugin@zcode-plugins-official",
      name: "empty-plugin",
      version: "0.1.0",
      enabled: false,
      source: "cache",
      marketplace: "zcode-plugins-official",
      skillCount: 0,
      skillRootCount: 0,
      commandRootCount: 0,
      declaredMcpServerNames: [],
      mcpServerNames: [],
      hookDetails: [],
      rootPath: "/cache/empty-plugin",
      components: [],
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(InstalledPluginDetailPanel, {
          getPluginOptionValue: (
            _plugin: ZCodePluginInfo,
            _key: string,
            option: ZCodePluginUserConfigOption,
          ) => option.default ?? "",
          onSavePluginOptions: () => {},
          operationId: null,
          plugin,
          renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
          setPluginOptionDraft: () => {},
        }),
      ),
    );

    expect(html).toContain("详情");
    expect(html).toContain("无组件");
  });
});
