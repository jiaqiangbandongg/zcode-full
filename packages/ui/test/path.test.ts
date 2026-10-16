import { describe, expect, it } from "vitest";
import { getContainingDirectoryPath, toFileUrl } from "@/lib/path.js";
import { getModelTrajectorySourceDirectory } from "@/ModelTrajectoryPane.js";

describe("path helpers", () => {
  it("解析 POSIX 和 Windows 文件的所在目录", () => {
    expect(getContainingDirectoryPath("/Users/dev/.zcode/cli/debug/model-io.jsonl")).toBe(
      "/Users/dev/.zcode/cli/debug",
    );
    expect(getContainingDirectoryPath("C:\\Users\\dev\\.zcode\\cli\\debug\\model-io.jsonl")).toBe(
      "C:\\Users\\dev\\.zcode\\cli\\debug",
    );
    expect(getContainingDirectoryPath("C:\\model-io.jsonl")).toBe("C:\\");
    expect(getContainingDirectoryPath("/model-io.jsonl")).toBe("/");
  });

  it("调用轨迹源文件目录会跳过空路径并回退到首个有效源文件", () => {
    expect(
      getModelTrajectorySourceDirectory([" ", "/Users/dev/.zcode/cli/rollout/model-io.jsonl"]),
    ).toBe("/Users/dev/.zcode/cli/rollout");
    expect(getModelTrajectorySourceDirectory(["model-io.jsonl"])).toBeNull();
    expect(getModelTrajectorySourceDirectory(undefined)).toBeNull();
  });

  // ZCT-2096502552646832128：encodeURI 不转义 # / ?，文件名含 # 时下游 URL 解析
  // 会把其后内容当 fragment，pathname 截断、shell 打开必然失败。回归以
  // new URL().pathname 的完整性为准——它才是真实消费路径（白名单与 fileURLToPath）。
  describe("toFileUrl", () => {
    it("Windows 盘符 + 中文 + 空格路径完整编码且可被 URL 解析还原", () => {
      const url = toFileUrl("E:\\web\\报告 v2.html");
      expect(url).toBe("file:///E:/web/%E6%8A%A5%E5%91%8A%20v2.html");
      expect(new URL(url).pathname).toBe("/E:/web/%E6%8A%A5%E5%91%8A%20v2.html");
    });

    it("文件名含 # 时转义为 %23，pathname 不被 fragment 截断", () => {
      const url = toFileUrl("E:\\web\\index#anchor.html");
      expect(url).toBe("file:///E:/web/index%23anchor.html");
      expect(new URL(url).hash).toBe("");
      expect(new URL(url).pathname).toBe("/E:/web/index%23anchor.html");
    });

    it("POSIX 路径含 # / ? / 空格 时同样完整转义", () => {
      const url = toFileUrl("/tmp/what? q#1.html");
      expect(url).toBe("file:///tmp/what%3F%20q%231.html");
      expect(new URL(url).pathname).toBe("/tmp/what%3F%20q%231.html");
      expect(new URL(url).search).toBe("");
      expect(new URL(url).hash).toBe("");
    });

    it("字面 % 字符被编码，不产生畸形 percent-encoding", () => {
      const url = toFileUrl("E:\\web\\50%.html");
      expect(url).toBe("file:///E:/web/50%25.html");
      expect(new URL(url).pathname).toBe("/E:/web/50%25.html");
    });

    it("纯 ASCII POSIX 路径保持既有输出不变", () => {
      expect(toFileUrl("/tmp/plain.html")).toBe("file:///tmp/plain.html");
    });
  });
});
