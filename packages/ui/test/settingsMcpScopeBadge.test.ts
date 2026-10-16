import { readSourceTextAsync } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

describe("settings MCP scope badge", () => {
  const toolCountClass =
    "inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border";
  const compactToolCountClass = toolCountClass.replace(
    "text-ui-sm",
    "text-ui-xs",
  );

  it("matches the Skill icon-and-label scope treatment", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/McpServerList.tsx", import.meta.url));
    const badgeSource = await readSourceTextAsync(
      new URL("../src/settings/SettingsScopeBadge.tsx", import.meta.url));

    expect(source).toContain("<SettingsScopeBadge");
    expect(source).toContain("includeMcpTestAttribute");
    expect(badgeSource).toContain("<Badge");
    expect(badgeSource).toContain(
      "data-mcp-scope={includeMcpTestAttribute ? scope : undefined}",
    );
    expect(badgeSource).toContain(
      'className="rounded-full border-border bg-surface text-ui-sm"',
    );
    expect(badgeSource).toContain(
      'data-icon="inline-start" className="size-3.5"',
    );
    expect(badgeSource).toContain('<Folder className="size-full"');
    expect(badgeSource).toContain('<UserRound className="size-full"');
    expect(source).toContain(
      '<Cable className="size-4" aria-hidden="true" />',
    );
    expect(badgeSource).toContain("`settings.scope.${scope}`");
    expect(source).toContain('data-mcp-status-dot-placement="icon-corner"');
    expect(source).toContain(
      'className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background"',
    );
    expect(source).toContain("size-2.5 shrink-0 fill-current");
    expect(source).not.toContain("size-2 shrink-0 fill-current");
    expect(source).toContain(
      'className="truncate text-ui-base font-medium text-foreground"',
    );
    expect(source).toContain("{server.name}");
    expect(source).not.toContain(
      'className="inline-flex items-center gap-1.5 truncate text-ui-base font-medium text-foreground"',
    );
    expect(source).toContain(': "text-foreground-subtlest"');
    expect(source).not.toContain(': "text-muted-foreground"');
    expect(source).toContain(
      '<ControlHintTooltip title={reason} className="max-w-64">',
    );
    expect(source).toContain("reason={statusReason}");
    expect(source).not.toContain("server.location?.directoryPath");
    expect(source).toContain(toolCountClass);
    expect(source).not.toContain(compactToolCountClass);
  });

  it("uses Plugin grouping and shared avatars for plugin MCP servers", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/McpSettingsSection.tsx", import.meta.url));

    expect(source).not.toContain("<Badge");
    expect(source).toContain("groupPluginMcpServersByPlugin");
    expect(source).toContain("data-mcp-plugin-group={group.pluginId}");
    expect(source).toContain("<PluginStoreAvatar");
    expect(source).toContain('className="size-9 bg-background"');
    // c0a58959fc 起插件 label 统一走 marketplace listing 解析（同名插件跨市场保持独立 label）。
    expect(source).toContain("resolvePluginDisplayName");
    expect(source).toContain("McpStatusDot");
    expect(source).toContain('from "@/settings/McpServerList.js"');
    expect(source).toContain("<McpStatusDot");
    expect(source).toContain("status={item.status}");
    expect(source).toContain(
      "attention={Boolean(item.authorization?.authorizationUrl)}",
    );
    expect(source).toContain("disabled={!item.pluginEnabled}");
    expect(source).toContain("reason={statusDescription}");
    expect(source).toContain('data-mcp-status-dot-placement="icon-corner"');
    expect(source).toContain('className="relative size-9 shrink-0"');
    expect(source).not.toContain("{status.label}");
    expect(source).not.toContain("formatCanonicalMarketplaceName");
    expect(source).not.toContain(toolCountClass);
    expect(source).not.toContain(compactToolCountClass);
  });
});
