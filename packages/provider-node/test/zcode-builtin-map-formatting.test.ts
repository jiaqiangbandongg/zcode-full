import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compileModelOptionMap, tokenizeRestrictedCel } from "@zcode/model-option-map";

describe("F98-01 Built-in 源 Map 结构排版", () => {
  it("所有嵌套对象分层展开，简单三目同行，简单单层输出 Map 保持紧凑", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    let checked = 0;
    for (const rules of Object.values(document.config.modelConfigRules) as Array<
      Array<{
        config: { optionSpecs?: Record<string, { map?: string }> };
      }>
    >) {
      for (const rule of rules) {
        for (const [name, option] of Object.entries(rule.config.optionSpecs ?? {})) {
          const map = option.map;
          if (!map) continue;
          compileModelOptionMap(map, name as "reasoningLevel" | "maxOutputTokens");
          const tokens = tokenizeRestrictedCel(map);
          let depth = 0;
          let nested = false;
          for (const token of tokens) {
            if (token.value === "{") nested ||= ++depth > 1;
            if (token.value === "}") depth--;
          }
          if (nested) {
            checked++;
            for (const token of tokens.filter((t) => t.value === "{")) {
              expect(map.slice(token.end), map).toMatch(/^\n +\S/);
            }
            for (const line of map.split("\n"))
              expect(line.match(/^ */)![0].length % 2, map).toBe(0);
          }
          // 简单三目不拆行；结构分支由对象展开体现，不把规则变成一个 formatter。
          tokens.forEach((token, index) => {
            if (token.value !== "?" || tokens[index + 2]?.value !== ":") return;
            if (!["string", "identifier", "number"].includes(tokens[index + 1]!.kind)) return;
            expect(map.slice(token.offset, tokens[index + 3]!.end), map).not.toContain("\n");
          });
          if (name === "maxOutputTokens") expect(map).not.toContain("\n");
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
