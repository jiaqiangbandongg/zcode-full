import { describe, expect, it } from "vitest";
import {
  DIFFS_PREFERRED_HIGHLIGHTER,
  createDiffsWorkerHighlighterOptions,
} from "../src/lib/diffsHighlighterEngine.js";

describe("diffsHighlighterEngine", () => {
  it("diff 高亮统一走 oniguruma WASM 引擎，避免 JS 正则引擎占满 V8 code space", () => {
    expect(DIFFS_PREFERRED_HIGHLIGHTER).toBe("shiki-wasm");
  });

  it("worker 池初始化参数带上引擎选择，主题沿用代码预览设置", () => {
    const options = createDiffsWorkerHighlighterOptions({
      lightTheme: "github-light",
      darkTheme: "github-dark",
    });

    expect(options.preferredHighlighter).toBe("shiki-wasm");
    expect(options.theme).toEqual({ light: "github-light", dark: "github-dark" });
    expect(options.lineDiffType).toBe("word-alt");
  });
});
