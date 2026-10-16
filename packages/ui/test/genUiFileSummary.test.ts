import { describe, expect, it } from "vitest";
import { buildAssistantPreviewCards } from "@/lib/assistantPreviewCards.js";

const path = "/workspace/visualizations/calendar.html";
const directive = `::visualize${JSON.stringify({ path })}`;

describe("visualize 源文件的预览卡片", () => {
  it.each([directive, `::visualize{path="${path}"}`, `visualize${JSON.stringify({ path })}`])(
    "有效引用不再生成 HTML 卡片：%s",
    (reference) => {
      expect(
        buildAssistantPreviewCards(`${reference}\n[日历](${path})`, "/workspace", {
          changedFilePaths: [path],
        }),
      ).toEqual([]);
    },
  );

  it("混合修改只隐藏被引用的完整路径，保留同名 HTML 和其他文件", () => {
    const cards = buildAssistantPreviewCards(
      `${directive}\n[日历](${path})\n[普通网页](/workspace/calendar.html)\nREADME.md report.pdf`,
      "/workspace",
      { changedFilePaths: [path, "/workspace/calendar.html", "/workspace/README.md"] },
    );
    expect(cards.map((card) => card.id)).toHaveLength(3);
    expect(cards.map((card) => card.title)).toEqual(["report.pdf", "README.md", "calendar.html"]);
    expect(cards.some((card) => card.type === "website" && card.filePath === path)).toBe(false);
  });

  it.each([
    `\`${directive}\``,
    `\`\`\`text\n${directive}\n\`\`\``,
    `::visualize{"path":"${path}"`,
    `::visualize{"path":"${path}","mode":"fullscreen"}`,
  ])("示例、未闭合或无效引用不隐藏普通 HTML：%s", (reference) => {
    expect(
      buildAssistantPreviewCards(`${reference}\n[日历](${path})`, "/workspace", {
        changedFilePaths: [path],
      }).map((card) => card.title),
    ).toEqual(["calendar.html"]);
  });

  it("Windows 引用与变更记录的分隔符一致化后匹配", () => {
    const windowsPath = String.raw`C:\workspace\visualizations\calendar.html`;
    expect(
      buildAssistantPreviewCards(
        `::visualize${JSON.stringify({ path: windowsPath })}\nC:/workspace/visualizations/calendar.html`,
        "C:/workspace",
        { changedFilePaths: ["C:/workspace/visualizations/calendar.html"] },
      ),
    ).toEqual([]);
  });
});
