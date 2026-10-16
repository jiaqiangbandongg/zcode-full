// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import type { MentionPanel } from "@/mentions/components/MentionPanel.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";

const mocks = vi.hoisted(() => ({
  plugins: vi.fn(),
  files: vi.fn(),
  sessions: vi.fn(),
  slashCommands: vi.fn(),
}));
vi.mock("@/hooks/useSlashCommands.js", () => ({ useSlashCommands: mocks.slashCommands }));
vi.mock("@/mentions/providers/pluginsMentionProvider.js", () => ({
  usePluginsMentionProvider: mocks.plugins,
}));
vi.mock("@/mentions/providers/fileMentionProvider.js", () => ({
  useFileMentionProvider: mocks.files,
}));
vi.mock("@/mentions/providers/sessionsMentionProvider.js", () => ({
  useSessionsMentionProvider: mocks.sessions,
}));
vi.mock("@/v4/activeTaskProvider.js", () => ({ useChatViewActiveTaskProvider: () => "zcode" }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
// 虚拟列表的尺寸与真实焦点由 Electron E2E 验证；这里保留菜单接线和所有候选。
vi.mock("@/mentions/components/MentionPanel.js", () => ({
  MentionPanel: ({ sections, onSelect, footer }: ComponentProps<typeof MentionPanel>) => {
    let index = 0;
    return createElement(
      "div",
      {},
      ...sections.map((section) =>
        createElement(
          "section",
          { key: section.id, "data-section": section.id },
          ...section.options.map((option) => {
            const optionIndex = index++;
            return createElement(
              "button",
              { key: option.id, onClick: () => onSelect(optionIndex) },
              option.id,
            );
          }),
        ),
      ),
      footer,
    );
  },
}));

function item(category: MentionItem["category"], id: string, disabled = false): MentionItem {
  return {
    id,
    category,
    label: id,
    description: "",
    value: id,
    markdown: `[@${id}](plugin://${id})`,
    disabled,
  };
}
function setup(
  attachment = true,
  sessionId: string | null = "session-1",
  text = "",
  excludedSlashCommandNames: readonly string[] = [],
  workflowInCatalog = false,
) {
  // 命令目录以 CLI catalog 为权威：仅当 catalog 含 workflow 时 + 菜单才提供工作流。
  mocks.slashCommands.mockReturnValue(
    workflowInCatalog ? [{ name: "goal" }, { name: "workflow" }, { name: "compact" }] : [],
  );
  const pluginItems = [item("plugins", "conflict", true), item("plugins", "enabled")];
  const fileItems = [item("files", "file:a")];
  const sessionItems = [item("sessions", "session:a")];
  for (const [mock, items, title] of [
    [mocks.plugins, pluginItems, "plugins"],
    [mocks.files, fileItems, "files"],
    [mocks.sessions, sessionItems, "sessions"],
  ] as const) {
    mock.mockReturnValue({ items, title, loading: false, error: null, emptyText: "" });
  }
  const savedState = {};
  const api = {
    getText: () => text,
    getEditorState: vi.fn(() => savedState),
    insertMention: vi.fn(),
    focus: vi.fn(),
  };
  const onSelect = vi.fn();
  const result = render(
    createElement(ChatPromptActionMenu, {
      actionMenuTitle: "Add context",
      attachmentAction: attachment ? { label: "Attachments", onSelect } : undefined,
      inputApiRef: { current: api as unknown as LexicalChatInputHandle },
      workspacePath: "/workspace",
      workspaceIdentity: "remote:test",
      sessionId,
      container: null,
      showPlugins: true,
      excludedSlashCommandNames,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  return { ...result, api, savedState, onSelect, pluginItems, fileItems, sessionItems };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("plus menu wiring", () => {
  it("preserves group order and provider scope without opting into disabled plugins", () => {
    setup();
    expect(
      [...document.querySelectorAll("[data-section]")].map((e) => e.getAttribute("data-section")),
    ).toEqual(["add", "plugins", "files", "sessions"]);
    expect(mocks.plugins.mock.lastCall).toEqual([
      "/workspace",
      "remote:test",
      "session-1",
      "",
      true,
      "chat.mention.plugins.empty",
      "chat.mention.plugins.title",
    ]);
    expect(mocks.files.mock.lastCall?.[6]).toBe(10);
    expect(mocks.sessions.mock.lastCall?.[5]).toBe("current-workspace");
  });
  it.each(["enabled", "file:a", "session:a"])(
    "inserts %s using the saved editor selection",
    (id) => {
      const { api, savedState } = setup();
      fireEvent.click(screen.getByText(id));
      expect(api.insertMention).toHaveBeenCalledWith(expect.objectContaining({ id }), savedState);
    },
  );
  it("inserts canonical goal when attachment is unavailable", () => {
    const { api, savedState } = setup(false, null);
    expect(screen.queryByText("attach-files")).toBeNull();
    fireEvent.click(screen.getByText("add-goal"));
    expect(api.insertMention).toHaveBeenCalledWith(
      expect.objectContaining({ category: "commands", markdown: "/goal", value: "goal" }),
      savedState,
    );
  });
  it.each([
    [null, "draft text"],
    ["session-1", ""],
    ["session-1", "message"],
  ] as const)("hides Goal for session=%s text=%s", (sessionId, text) => {
    setup(true, sessionId, text);
    expect(screen.queryByText("add-goal")).toBeNull();
  });
  it("offers Workflow right after Goal in an empty new draft when the catalog has it", () => {
    const { api, savedState } = setup(true, null, "", [], true);
    expect(
      [...document.querySelectorAll('[data-section="add"] button')].map((e) => e.textContent),
    ).toEqual(["attach-files", "add-goal", "add-workflow"]);
    fireEvent.click(screen.getByText("add-workflow"));
    expect(api.insertMention).toHaveBeenCalledWith(
      expect.objectContaining({ category: "commands", markdown: "/workflow", value: "workflow" }),
      savedState,
    );
  });
  it("offers Workflow without Goal in an existing session with an empty draft", () => {
    const { api } = setup(false, "session-1", "", [], true);
    expect(screen.queryByText("add-goal")).toBeNull();
    fireEvent.click(screen.getByText("add-workflow"));
    expect(api.insertMention).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: "/workflow" }),
      expect.anything(),
    );
  });
  it("keeps mention indices aligned when Workflow is the only quick command", () => {
    const { api } = setup(true, "session-1", "", [], true);
    fireEvent.click(screen.getByText("enabled"));
    expect(api.insertMention).toHaveBeenCalledWith(
      expect.objectContaining({ id: "enabled" }),
      expect.anything(),
    );
  });
  it.each([
    ["non-empty draft", null, "draft text", [], true],
    ["catalog without workflow", null, "", [], false],
    ["excluded name", "session-1", "", ["workflow"], true],
  ] as const)("hides Workflow for %s", (_label, sessionId, text, excluded, inCatalog) => {
    setup(true, sessionId, text, excluded, inCatalog);
    expect(screen.queryByText("add-workflow")).toBeNull();
  });
  it("respects side chat Goal exclusions", () => {
    setup(true, null, "", ["goal"]);
    expect(screen.queryByText("add-goal")).toBeNull();
  });
  it("hides Goal for whitespace-only drafts", () => {
    setup(true, null, "  ");
    expect(screen.queryByText("add-goal")).toBeNull();
  });
  it("omits an empty Add section", () => {
    setup(false, "session-1");
    expect(document.querySelector('[data-section="add"]')).toBeNull();
  });
  it("calls the attachment action once without inserting a mention", () => {
    const { api, onSelect } = setup();
    fireEvent.click(screen.getByText("attach-files"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(api.insertMention).not.toHaveBeenCalled();
  });
  it("rejects conflicts and skips them during keyboard navigation", () => {
    const { api } = setup();
    fireEvent.click(screen.getByText("conflict"));
    expect(api.insertMention).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(api.insertMention).toHaveBeenCalledWith(
      expect.objectContaining({ id: "enabled" }),
      expect.anything(),
    );
  });
});
