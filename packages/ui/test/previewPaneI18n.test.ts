import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

describe("PreviewPane i18n", () => {
  it("未选择编辑器时中文提示已翻译且英文保持不变", () => {
    expect(zhCN["chat.changeSummary.openInEditor"]).toBe("在编辑器中打开");
    expect(enUS["chat.changeSummary.openInEditor"]).toBe("Open in editor");
  });

  it("绝对路径和相对路径复制入口具备成对翻译", () => {
    expect(zhCN["fileActions.copyAbsolutePath"]).toBe("复制绝对路径");
    expect(enUS["fileActions.copyAbsolutePath"]).toBe("Copy absolute path");
    expect(zhCN["fileActions.copyRelativePath"]).toBe("复制相对路径");
    expect(enUS["fileActions.copyRelativePath"]).toBe("Copy relative path");
  });

  it("provides localized PPTX preview controls and errors", () => {
    expect(enUS["codeViewer.pptx.previousPage"]).toBe("Previous slide");
    expect(enUS["codeViewer.pptx.fileTooLarge"]).toContain("64 MB");
    expect(enUS["codeViewer.pptx.legacyFileTooLarge"]).toContain("8 MB");
    expect(enUS["codeViewer.pptx.incomplete"]).toContain("truncated");
    expect(zhCN["codeViewer.pptx.previousPage"]).toBe("上一张幻灯片");
    expect(zhCN["codeViewer.pptx.fileTooLarge"]).toContain("64 MB");
    expect(zhCN["codeViewer.pptx.legacyFileTooLarge"]).toContain("8 MB");
    expect(zhCN["codeViewer.pptx.incomplete"]).toContain("截断");
    expect(enUS["codeViewer.pptx.aiEdit"]).toBe("AI Edit");
    expect(zhCN["codeViewer.pptx.aiEdit"]).toBe("AI 编辑");
    expect(enUS["codeViewer.pptx.commentPlaceholder"]).toContain("comment");
    expect(zhCN["codeViewer.pptx.commentPlaceholder"]).toContain("评论");
    expect(enUS["codeViewer.pptx.cancelAiEdit"]).toBe("Cancel");
    expect(zhCN["codeViewer.pptx.cancelAiEdit"]).toBe("取消");
    expect(enUS["codeViewer.pptx.addToConversation"]).toBe("Add to conversation");
    expect(zhCN["codeViewer.pptx.addToConversation"]).toBe("添加到对话");
  });

  it("provides paired translations for PPTX export-as-PDF actions", () => {
    expect(enUS["codeViewer.pptx.exportPdf"]).toBe("Export as PDF");
    expect(zhCN["codeViewer.pptx.exportPdf"]).toBe("导出为 PDF");
    expect(enUS["codeViewer.pptx.exportingPdf"]).toBe("Exporting PDF...");
    expect(zhCN["codeViewer.pptx.exportingPdf"]).toBe("正在导出 PDF...");
    expect(enUS["codeViewer.pptx.exportPdfSuccess"]).toContain("{path}");
    expect(zhCN["codeViewer.pptx.exportPdfSuccess"]).toContain("{path}");
    expect(enUS["codeViewer.pptx.exportPdfFailed"]).toBe("Failed to export PDF");
    expect(zhCN["codeViewer.pptx.exportPdfFailed"]).toBe("PDF 导出失败");
  });

  it("localizes the bounded text preview message", () => {
    expect(enUS["codeViewer.fileTooLarge"]).toContain("256 KB");
    expect(enUS["codeViewer.fileTooLarge"]).toContain("another editor");
    expect(zhCN["codeViewer.fileTooLarge"]).toContain("256 KB");
    expect(zhCN["codeViewer.fileTooLarge"]).toContain("其他编辑器");
  });
});
