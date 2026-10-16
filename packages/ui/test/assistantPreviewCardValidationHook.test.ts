// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantPreviewCardValidation } from "@/AssistantPreviewCards.js";
import type {
  AssistantPreviewCard,
  AssistantPreviewCardFileStatService,
} from "@/lib/assistantPreviewCards.js";

const mocks = vi.hoisted(() => ({
  useWorkspaceServices: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: mocks.useWorkspaceServices,
}));

function createPptxCard(path: string): AssistantPreviewCard {
  const title = path.split("/").at(-1) ?? path;
  return {
    id: `file:pptx:${path}`,
    type: "file",
    kind: "pptx",
    title,
    subtitleId: "chat.previewCards.pptx",
    path,
  };
}

function createFileService(): AssistantPreviewCardFileStatService & {
  checkFilesExist: ReturnType<typeof vi.fn>;
} {
  return {
    checkFilesExist: vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: true })),
    ),
  };
}

describe("useAssistantPreviewCardValidation", () => {
  beforeEach(() => {
    mocks.useWorkspaceServices.mockReset();
  });

  it("语义相同但数组引用变化时复用已完成的存在性校验", async () => {
    const fileService = createFileService();
    mocks.useWorkspaceServices.mockReturnValue({ fileService });
    const firstCards = [createPptxCard("/workspace/deck.pptx")];
    const { result, rerender } = renderHook(
      ({ cards }: { cards: AssistantPreviewCard[] }) =>
        useAssistantPreviewCardValidation(cards, { workspacePath: "/workspace" }),
      { initialProps: { cards: firstCards } },
    );

    await waitFor(() => {
      expect(result.current.settled).toBe(true);
    });
    expect(fileService.checkFilesExist).toHaveBeenCalledTimes(1);

    rerender({ cards: firstCards.map((card) => ({ ...card })) });

    expect(result.current.settled).toBe(true);
    expect(result.current.visibleCards).toEqual(firstCards);
    expect(fileService.checkFilesExist).toHaveBeenCalledTimes(1);
  });

  it("路径签名或 workspace fileService 改变时重新校验", async () => {
    const firstFileService = createFileService();
    const secondFileService = createFileService();
    mocks.useWorkspaceServices.mockReturnValue({ fileService: firstFileService });
    const { result, rerender } = renderHook(
      ({ cards }: { cards: AssistantPreviewCard[] }) =>
        useAssistantPreviewCardValidation(cards, { workspacePath: "/workspace" }),
      { initialProps: { cards: [createPptxCard("/workspace/first.pptx")] } },
    );

    await waitFor(() => {
      expect(firstFileService.checkFilesExist).toHaveBeenCalledTimes(1);
    });

    const secondCards = [createPptxCard("/workspace/second.pptx")];
    rerender({ cards: secondCards });
    await waitFor(() => {
      expect(firstFileService.checkFilesExist).toHaveBeenCalledTimes(2);
      expect(result.current.visibleCards).toEqual(secondCards);
    });

    mocks.useWorkspaceServices.mockReturnValue({ fileService: secondFileService });
    rerender({ cards: secondCards.map((card) => ({ ...card })) });
    await waitFor(() => {
      expect(secondFileService.checkFilesExist).toHaveBeenCalledTimes(1);
      expect(result.current.visibleCards).toEqual(secondCards);
    });
    expect(firstFileService.checkFilesExist).toHaveBeenCalledTimes(2);
  });
});
