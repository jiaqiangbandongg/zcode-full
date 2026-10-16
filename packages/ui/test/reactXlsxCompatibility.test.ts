// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { XlsxViewerProvider, initWasm, setWasmSource, useXlsxViewer } from "@extend-ai/react-xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 回归原因：部分写入器会把 OOXML part 写成 Windows 反斜杠 ZIP entry，
// react-xlsx 0.15 会将这类可恢复的工作簿误报为缺少 worksheet。
const BACKSLASH_ENTRY_XLSX_BASE64 =
  "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";

function decodeFixture(): ArrayBuffer {
  return Uint8Array.from(Buffer.from(BACKSLASH_ENTRY_XLSX_BASE64, "base64")).buffer;
}

function WorkbookStateProbe() {
  const { error, isLoading, tabs } = useXlsxViewer();

  return createElement("output", {
    "data-error": error?.message ?? "",
    "data-loading": String(isLoading),
    "data-tabs": tabs.map((tab) => tab.name).join(","),
    "data-testid": "workbook-state",
  });
}

beforeAll(async () => {
  const wasmUrl = new URL(import.meta.resolve("@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm"));
  const wasmBytes = Uint8Array.from(await readFile(wasmUrl));
  setWasmSource(wasmBytes.buffer);
  await initWasm();
});

afterAll(() => {
  cleanup();
});

describe("react-xlsx compatibility", () => {
  it("parses workbooks whose ZIP entries use Windows path separators", async () => {
    const view = render(
      createElement(
        XlsxViewerProvider,
        {
          file: decodeFixture(),
          fileName: "backslash-paths.xlsx",
          readOnly: true,
          useWorker: false,
        },
        createElement(WorkbookStateProbe),
      ),
    );

    const state = view.getByTestId("workbook-state");
    await waitFor(() => {
      expect(state.getAttribute("data-loading")).toBe("false");
    });

    expect(state.getAttribute("data-error")).toBe("");
    expect(state.getAttribute("data-tabs")).toBe("Sheet1");
  });
});
