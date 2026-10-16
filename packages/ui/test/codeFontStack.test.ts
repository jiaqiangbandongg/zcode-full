import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles.css", "utf8");
const codeViewerSource = readFileSync(
  "packages/ui/src/components/ui/code-viewer.tsx",
  "utf8",
);
const diffViewerSource = readFileSync(
  "packages/ui/src/components/ui/diff-viewer.tsx",
  "utf8",
);

describe("code font stack", () => {
  it("uses sans-serif CJK fallbacks before generic monospace", () => {
    expect(styles).toMatch(
      /--font-mono:[^;]*Consolas[^;]*"Microsoft YaHei UI"[^;]*"Microsoft YaHei"[^;]*"PingFang SC"[^;]*"Noto Sans CJK SC"[^;]*monospace;/u,
    );
  });

  it("shares the CJK-safe mono token with code and diff viewers", () => {
    expect(codeViewerSource).toContain('"--diffs-font-family": "var(--font-mono)"');
    expect(diffViewerSource).toContain('"--diffs-font-family": "var(--font-mono)"');
  });
});
