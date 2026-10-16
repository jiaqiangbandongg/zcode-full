// 脚本文件的模型面写法（docs/dynamic-workflow/launch.md「Script files」）。
//
// 一个纯函数被单独钉住，是因为三个模型面（终态通知、GetWorkflowRun、工具响应）都要说出
// **同一个**路径：模型读到什么，下一次 `Edit` 和 `AmendWorkflow` 的 `path` 就是什么。相对化
// 的判据一旦飘了，模型就会去编辑一个不存在的文件，或者收到一个它读不懂的绝对路径。
//
// 全部路径都用 `path.join` / `path.resolve` 拼，所以这组用例在 POSIX 与 Windows 上钉的是
// 同一条规则（分隔符与盘符由 node:path 自己给出）。

import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkflowScriptPath } from "../src/tool/handlers/workflow-script-path.js";

const CWD = path.resolve(path.sep, "repo");

describe("describeWorkflowScriptPath", () => {
  it("工作目录之下：给工作区相对路径（模型接下来 Edit 用的就是这一种）", () => {
    const absolute = path.join(CWD, ".zcode", "workflow-drafts", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, CWD)).toBe(
      path.join(".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
  });

  it("工作目录之外：原样给绝对路径（相对写法会读起来像工作区里有这么个东西）", () => {
    const outside = path.resolve(path.sep, "elsewhere", "shared", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(outside, CWD)).toBe(outside);
  });

  it("同级的兄弟目录也算目录外：`..` 开头的结果一律退回绝对路径", () => {
    const sibling = path.resolve(CWD, "..", "other-repo", "audit.dwf.ts");
    const relative = path.relative(CWD, sibling);
    expect(relative.startsWith("..")).toBe(true);
    expect(describeWorkflowScriptPath(sibling, CWD)).toBe(sibling);
  });

  it("cwd 缺席或为空：无从相对化，原样给绝对路径", () => {
    const absolute = path.join(CWD, "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, undefined)).toBe(absolute);
    expect(describeWorkflowScriptPath(absolute, "")).toBe(absolute);
  });

  it("路径恰好等于工作目录：空串不是一个能 Edit 的文件名，退回绝对路径", () => {
    expect(describeWorkflowScriptPath(CWD, CWD)).toBe(CWD);
  });

  it("嵌套更深的工作目录：相对写法从工作目录起算，而不是从仓库根", () => {
    const nested = path.join(CWD, "apps", "cli");
    const absolute = path.join(nested, ".zcode", "workflow-drafts", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, nested)).toBe(
      path.join(".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
    // 同一个文件、更靠外的工作目录：相对写法随之变长，绝对路径不变——journal 存的是后者。
    expect(describeWorkflowScriptPath(absolute, CWD)).toBe(
      path.join("apps", "cli", ".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
  });

  // Windows 的跨盘符：`path.relative` 给回的是绝对路径，本函数的第二道判据据此退回原值。
  // 只有在 Windows 上跑才有意义（POSIX 的 `path.relative` 不认盘符）。
  it.runIf(process.platform === "win32")("Windows 跨盘符：退回绝对路径", () => {
    expect(describeWorkflowScriptPath("D:\\\\drafts\\\\audit.dwf.ts", "C:\\\\repo")).toBe(
      "D:\\\\drafts\\\\audit.dwf.ts",
    );
  });
});
