import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 读取仓库源码用于文本契约断言。
 *
 * Bugfix：下面断言里有跨行片段（`turnNavigatorHasLayoutRoom &&\n            "..."`），
 * 而仓库只对 *.mjs / *.sh 声明了 `eol=lf`，其余源码在 `core.autocrlf=true` 的 Windows
 * 检出里是 CRLF，`toContain` 的 `\n` 匹配不到 `\r\n`，用例在 Windows 上必然失败。
 * 它想断言的是源码内容契约，与换行字节无关，统一归一成 LF 再比对。
 */
const readSource = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

describe("markdown table layout root", () => {
  it("connects V4 timeline tables to the expanded-scroll layout boundary", () => {
    const tableSource = readSource("packages/ui/src/components/ai-elements/markdown-table.tsx");
    const timelineSource = readSource("packages/ui/src/v4/ConversationTimeline.tsx");

    expect(tableSource).toContain('[data-markdown-table-layout-root="true"]');
    expect(tableSource).toContain('[data-testid="chat-view"]');
    expect(timelineSource).toContain('data-markdown-table-layout-root="true"');
    expect(timelineSource).toContain(
      "[--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px]",
    );
    expect(timelineSource).toContain(
      'turnNavigatorQueryRowIds.size >= 2 &&\n            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]"',
    );
    expect(timelineSource.indexOf('data-markdown-table-layout-root="true"')).toBeLessThan(
      timelineSource.indexOf('data-v4-timeline-content-column="true"'),
    );
  });
});
