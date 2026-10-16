// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IMemoryService } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  testId,
} from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string | number>,
      ) =>
        values
          ? `${id}:${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`
          : id,
    },
  }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: ({
    workspaceAbsPath,
  }: {
    workspaceAbsPath: string;
  }) =>
    createElement("button", {
      "data-testid": `memory-editor-${workspaceAbsPath}`,
      type: "button",
    }),
}));

vi.mock("@/settings/PluginScopeMenu.js", () => ({
  PluginScopeMenu: ({
    includeUser,
    onScopeKeyChange,
    selectedScopeKey,
    triggerIconTestId,
    triggerTestId,
    workspaceOptions,
  }: {
    includeUser: boolean;
    onScopeKeyChange: (key: string) => void;
    selectedScopeKey: string;
    triggerIconTestId: string;
    triggerTestId: string;
    workspaceOptions: Array<{ key: string; label: string }>;
  }) =>
    createElement(
      "div",
      { "data-include-user": String(includeUser) },
      createElement(
        "button",
        { "data-testid": triggerTestId, type: "button" },
        createElement("span", {
          className: "lucide-folder",
          "data-testid": triggerIconTestId,
        }),
        workspaceOptions.find((option) => option.key === selectedScopeKey)
          ?.label,
      ),
      ...workspaceOptions.map((option) =>
        createElement(
          "button",
          {
            key: option.key,
            role: "menuitemradio",
            type: "button",
            onClick: () => onScopeKeyChange(option.key),
          },
          option.label,
        ),
      ),
    ),
}));

import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

const workspaces = [
  {
    id: "z-code-1111111111111111",
    label: "z-code",
    updatedAt: 20,
    files: [
      {
        name: "MEMORY.md",
        path: "/memory/z-code/MEMORY.md",
        kind: "index" as const,
        size: 12,
        updatedAt: 20,
      },
      {
        name: "fact-a.md",
        path: "/memory/z-code/fact-a.md",
        kind: "item" as const,
        size: 10,
        updatedAt: 10,
      },
    ],
  },
  {
    id: "second-2222222222222222",
    label: "second",
    updatedAt: 15,
    files: [
      {
        name: "fact-b.md",
        path: "/memory/second/fact-b.md",
        kind: "item" as const,
        size: 8,
        updatedAt: 15,
      },
    ],
  },
];

function createService(): MemoryCatalogService {
  return {
    listProjectMemories: vi.fn(async () => workspaces),
  };
}

function renderSection(
  memoryService: MemoryCatalogService,
  memoryEnabled = true,
  workspaceDisplayNames: readonly string[] = [],
) {
  const onMemoryEnabledChange = vi.fn(async () => {});
  render(
    createElement(MemorySettingsSection, {
      memoryEnabled,
      memoryService,
      onMemoryEnabledChange,
      projectMemoryViewerAvailable: true,
      workspaceDisplayNames,
    }),
  );
  return { onMemoryEnabledChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemorySettingsSection", () => {
  it("开关位于 Workspace Scope 工具栏上方，关闭时不读取 catalog", () => {
    const memoryService = createService();
    renderSection(memoryService, false);
    expect(
      screen.getByRole("switch", { name: "settings.memory.workspaceMemory" }),
    ).toBeTruthy();
    expect(screen.queryByText("settings.memory.viewer.disabled")).toBeNull();
    expect(screen.queryByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER)).toBeNull();
    expect(memoryService.listProjectMemories).not.toHaveBeenCalled();
  });

  it("默认选择首个 Workspace 并直接显示该 Scope 的文件", async () => {
    renderSection(createService(), true, ["Z Code", "Second"]);
    const scopeTrigger = await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    expect(scopeTrigger.textContent).toContain("Z Code");
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_ICON)).toBeTruthy();
    expect(screen.queryByText("User")).toBeNull();
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_COUNT).textContent).toBe(
      "settings.memory.viewer.memoryCount.other:count=2",
    );
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md")),
    ).toBeTruthy();
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_ICON, "MEMORY.md")),
    ).toBeTruthy();
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, "MEMORY.md"))
        .textContent,
    ).toContain(
      "settings.memory.viewer.updated.date",
    );
    const fileName = screen.getByTestId(
      testId(TID_SETTINGS_MEMORY_FILE_NAME, "MEMORY.md"),
    );
    expect(fileName.className).toContain("font-medium");
    expect(fileName.className).not.toContain("font-mono");
    expect(
      screen.getByTestId("memory-editor-/memory/z-code/MEMORY.md"),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, "MEMORY.md"),
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-a.md")),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md")),
    ).toBeNull();
    const filesHeading = screen.getByRole("heading", {
      name: "settings.memory.viewer.files",
    });
    const filesHeader = filesHeading.parentElement;
    expect(
      filesHeader?.querySelector('[data-testid="settings-memory-refresh"]'),
    ).toBeTruthy();
  });

  it("Workspace Scope 按 settings.json 提供的 recentProjects 顺序排列", async () => {
    renderSection(createService(), true, ["Second", "Z Code"]);

    expect(
      (await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER)).textContent,
    ).toContain("Second");
    expect(
      screen.getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(["Second", "Z Code"]);
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md")),
    ).toBeTruthy();
  });

  it("Scope 菜单只列出 Workspace，切换后替换文件列表", async () => {
    renderSection(createService());
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    expect(screen.queryByRole("menuitemradio", { name: /User/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /second/ }));
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent).toContain(
      "second",
    );
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-b.md")),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md")),
    ).toBeNull();
  });

  it("按当前 Scope 的文件名忽略大小写搜索，无结果时隐藏文件分组", async () => {
    renderSection(createService());
    const search = await screen.findByTestId(TID_SETTINGS_MEMORY_SEARCH_INPUT);

    fireEvent.change(search, { target: { value: "FACT-A" } });
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "fact-a.md")),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md")),
    ).toBeNull();
    expect(screen.getByTestId(TID_SETTINGS_MEMORY_SEARCH_CLEAR)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_SEARCH_CLEAR));
    expect(
      screen.getByTestId(testId(TID_SETTINGS_MEMORY_FILE, "MEMORY.md")),
    ).toBeTruthy();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("settings.memory.viewer.searchEmpty")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "settings.memory.viewer.files" }),
    ).toBeNull();
  });

  it("刷新保留当前 Scope；Scope 消失时回退首项", async () => {
    const memoryService = createService();
    renderSection(memoryService);
    await screen.findByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /second/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "settings.memory.viewer.refresh" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent,
      ).toContain(
        "second",
      ),
    );

    vi.mocked(memoryService.listProjectMemories).mockResolvedValueOnce([
      workspaces[0],
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.memory.viewer.refresh" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(TID_SETTINGS_MEMORY_SCOPE_TRIGGER).textContent,
      ).toContain(
        "z-code",
      ),
    );
  });

  it("保留 loading、empty 与 error 反馈", async () => {
    let resolveCatalog: ((value: []) => void) | undefined;
    const memoryService = createService();
    vi.mocked(memoryService.listProjectMemories).mockImplementationOnce(
      () => new Promise((resolve) => (resolveCatalog = resolve)),
    );
    renderSection(memoryService);
    expect(screen.getByText("settings.memory.viewer.loading")).toBeTruthy();
    resolveCatalog?.([]);
    expect(
      await screen.findByText("settings.memory.viewer.empty"),
    ).toBeTruthy();
  });

  it("Web Remote / Mobile 只展示开关和本地查看提示", () => {
    const memoryService = createService();
    render(
      createElement(MemorySettingsSection, {
        memoryEnabled: true,
        memoryService,
        onMemoryEnabledChange: vi.fn(async () => {}),
        projectMemoryViewerAvailable: false,
      }),
    );
    expect(screen.getByText("settings.memory.viewer.localOnly")).toBeTruthy();
    expect(memoryService.listProjectMemories).not.toHaveBeenCalled();
  });
});
