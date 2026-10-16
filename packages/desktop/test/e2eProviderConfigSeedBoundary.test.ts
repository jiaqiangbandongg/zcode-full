import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
const seedHelperSource = readFileSync(
  new URL("./e2e/helpers/model-provider-restart-config.ts", import.meta.url),
  "utf8",
);
const e2eRoot = new URL("./e2e/", import.meta.url);

describe("Desktop E2E Provider seed boundary", () => {
  it("普通 WDIO fixture 不再写旧 model-providers.json", () => {
    expect(source).not.toContain("E2E_MODEL_PROVIDERS_FILE");
    expect(source).toContain("seedPersonalProviderConfig");
  });

  it("普通 WDIO fixture 不再把 Provider 复制到旧 CLI Config", () => {
    const writerStart = source.indexOf("function seedE2EWorkerModelStreamConfig");
    const writerEnd = source.indexOf("async function seedModelOutputTokenProviders");
    const cliWriterSource = source.slice(writerStart, writerEnd);

    expect(writerStart).toBeGreaterThanOrEqual(0);
    expect(writerEnd).toBeGreaterThan(writerStart);
    // 这里只约束 Provider seed 的写入边界。其他 E2E（例如 workspace plugin）也会
    // 合法读写同一个 CLI config，不能用全文件引用次数间接表达 Provider 契约。
    expect(cliWriterSource).toContain("E2E_CLI_CONFIG_FILE");
    expect(cliWriterSource).not.toContain("provider:");
    expect(cliWriterSource).not.toContain("model:");
  });

  it("Personal Config seed 不再以旧 Provider Store DTO 为输入", () => {
    expect(source).not.toMatch(/\bModelProviderConfig\b/u);
    expect(seedHelperSource).not.toMatch(/\bModelProviderConfig\b/u);
    expect(seedHelperSource).not.toContain("isModelProviderModelConfig");
    expect(seedHelperSource).not.toContain("resolveModelProviderApiFormat");
  });

  it("E2E 观察与断言不再依赖旧 Provider Store 顶层 DTO", () => {
    const legacyReferences = collectTypeScriptSources(e2eRoot).filter(({ source }) =>
      /\bModelProviderConfig\b/u.test(source),
    );

    expect(legacyReferences.map(({ path }) => path)).toEqual([]);
  });
});

function collectTypeScriptSources(root: URL): Array<{ path: string; source: string }> {
  const result: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) {
      result.push(...collectTypeScriptSources(child));
    } else if (extname(entry.name) === ".ts") {
      result.push({
        path: join(root.pathname, entry.name),
        source: readFileSync(child, "utf8"),
      });
    }
  }
  return result;
}
