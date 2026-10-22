import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";

const SAMPLE_BYTES = 4096;
const LARGE_FILE_BYTES = 11 * 1024 * 1024;
const UTF8_BOUNDARIES = [
  { char: "é", keptBytes: 1 },
  { char: "中", keptBytes: 1 },
  { char: "中", keptBytes: 2 },
  { char: "😀", keptBytes: 1 },
  { char: "😀", keptBytes: 2 },
  { char: "😀", keptBytes: 3 },
];

describe("text encoding at a sampled file boundary", () => {
  const directories: string[] = [];
  const fs = createNodeFileSystemAdapter();

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function createFile(bytes: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zcode-text-encoding-"));
    directories.push(dir);
    const path = join(dir, "sample.txt");
    await writeFile(path, bytes);
    return path;
  }

  function largeText(head: string, encoding = "utf8"): Buffer {
    const tail = "这是合法的文本行。\n";
    const repeats = Math.ceil(LARGE_FILE_BYTES / iconv.encode(tail, encoding).length);
    return iconv.encode(head + tail.repeat(repeats), encoding);
  }

  it.each(UTF8_BOUNDARIES)(
    "preserves $char when the sample keeps $keptBytes bytes",
    async ({ char, keptBytes }) => {
      const firstLine = "a".repeat(SAMPLE_BYTES - keptBytes) + char + "正文";
      const path = await createFile(largeText(`${firstLine}\n`));
      const read = await fs.readTextFileRange({ path, limitLines: 2 });
      expect(read.encoding).toBe("utf8");
      expect(read.content).toBe(`${firstLine}\n这是合法的文本行。`);
      expect(read.lineCount).toBe(2);
      // Bug 根因：旧实现将样本末尾的半个字符当成完整文件错误，导致拒读或误判为 legacy 编码。
      const later = await fs.readTextFileRange({ path, offsetLine: 2500, limitLines: 2 });
      expect(later.content).toBe("这是合法的文本行。\n这是合法的文本行。");
    },
  );

  it.each(UTF8_BOUNDARIES)(
    "does not accept an incomplete $char at actual EOF ($keptBytes bytes) as UTF-8",
    async ({ char, keptBytes }) => {
      const sample = Buffer.concat([
        Buffer.from("a".repeat(SAMPLE_BYTES - keptBytes)),
        Buffer.from(char).subarray(0, keptBytes),
      ]);
      const path = await createFile(sample);
      // 完整输入不能沿用前缀宽容模式；已有 legacy 检测可拒绝或选择其他编码。
      const read = await fs.readTextFile({ path }).catch((error: { code: string }) => {
        expect(error.code).toBe("unsupported");
        return null;
      });
      expect(read?.encoding).not.toBe("utf8");
    },
  );

  it("rejects invalid UTF-8 inside the sample instead of replacing it", async () => {
    const path = await createFile(Buffer.concat([Buffer.from([0xff]), largeText("\n")]));
    await expect(fs.readTextFileRange({ path, limitLines: 2 })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("keeps GBK after an ASCII prefix when its lead byte resembles pending UTF-8", async () => {
    const firstLine = "a".repeat(SAMPLE_BYTES - 1) + "中文";
    const path = await createFile(largeText(`${firstLine}\n`, "gbk"));
    // D6 | D0：单看 D6 可等待 UTF-8 续字节，但 D0 会排除 UTF-8；不能提前接受候选。
    const read = await fs.readTextFileRange({ path, limitLines: 2 });
    expect(read.content).toBe(`${firstLine}\n这是合法的文本行。`);
    expect(read.encoding).toBe("gb2312");
  });

  it.each([
    { name: "invalid continuation", prefix: [0xe4], rest: [0xff, 0xad] },
    { name: "overlong sequence", prefix: [0xe0], rest: [0x80, 0x80] },
    { name: "surrogate", prefix: [0xed], rest: [0xa0, 0x80] },
    { name: "out-of-range code point", prefix: [0xf4], rest: [0x90, 0x80, 0x80] },
  ])("does not accept $name beyond the sample as UTF-8", async ({ prefix, rest }) => {
    const path = await createFile(
      Buffer.concat([
        Buffer.alloc(SAMPLE_BYTES - prefix.length, "a"),
        Buffer.from(prefix),
        Buffer.from(rest),
        largeText("\n"),
      ]),
    );
    const read = await fs
      .readTextFileRange({ path, limitLines: 1 })
      .catch((error: { code: string }) => {
        expect(error.code).toBe("unsupported");
        return null;
      });
    expect(read?.encoding).not.toBe("utf8");
  });

  it("completes the boundary sequence across short reads without consuming the next character", async () => {
    const firstLine = "a".repeat(SAMPLE_BYTES - 1) + "😀中";
    const path = await createFile(largeText(`${firstLine}\n`));
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) {
      return originalRead.call(
        this,
        buffer,
        offset,
        position === 0 ? length : Math.min(1, length),
        position,
      );
    } as never);
    const read = await fs.readTextFileRange({ path, limitLines: 1 });
    expect(read.encoding).toBe("utf8");
    expect(read.content).toBe(firstLine);
  });

  it.each([
    { encoding: "gb2312", firstLine: "这是中文文本。" },
    { encoding: "gbk", firstLine: "丂这是中文文本。" },
    { encoding: "gb18030", firstLine: "𠀀这是中文文本。" },
  ])(
    "keeps $encoding text readable across the sample boundary",
    async ({ encoding, firstLine }) => {
      const path = await createFile(largeText(`${firstLine}\n`, encoding));
      const read = await fs.readTextFileRange({ path, limitLines: 2 });
      expect(read.content).toBe(`${firstLine}\n这是合法的文本行。`);
      expect(read.encoding).not.toBe("utf8");
    },
  );

  it.each(["utf8", "utf16le"])("preserves %s BOM detection", async (encoding) => {
    const path = await createFile(largeText("\uFEFF中文\n", encoding));
    const read = await fs.readTextFileRange({ path, limitLines: 2 });
    expect(read.encoding).toBe(encoding);
    expect(read.content).toBe("\uFEFF中文\n这是合法的文本行。");
  });

  it("continues sampling after a short read before selecting the encoding", async () => {
    const path = await createFile(largeText("a这是中文文本。\n", "gb2312"));
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let first = true;
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof probe,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) {
      const size = first ? 1 : length;
      first = false;
      return originalRead.call(this, buffer, offset, size, position);
    } as never);
    const read = await fs.readTextFileRange({ path, limitLines: 1 });
    expect(read.encoding).toBe("gb2312");
    expect(read.content).toBe("a这是中文文本。");
  });

  it.each([1, 2, 3])(
    "uses actual EOF when only %i emoji bytes remain after stat",
    async (keptBytes) => {
      const path = await createFile(largeText("完整文本\n"));
      const incomplete = Buffer.concat([
        Buffer.from("a".repeat(SAMPLE_BYTES - 1)),
        Buffer.from("😀").subarray(0, keptBytes),
      ]);
      const probe = await open(path, "r");
      const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
      const originalRead = prototype.read;
      await probe.close();
      let first = true;
      vi.spyOn(prototype, "read").mockImplementation(async function (
        this: typeof probe,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) {
        if (first) {
          first = false;
          await writeFile(path, incomplete);
        }
        return originalRead.call(this, buffer, offset, length, position);
      } as never);
      const read = await fs
        .readTextFileRange({ path, limitLines: 1 })
        .catch((error: { code: string }) => {
          expect(error.code).toBe("unsupported");
          return null;
        });
      expect(read?.encoding).not.toBe("utf8");
    },
  );
});
