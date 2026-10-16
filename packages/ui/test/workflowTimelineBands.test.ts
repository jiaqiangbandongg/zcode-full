// 带的折叠（docs/dynamic-workflow/presentation.md「The timeline model」）：把分析器的
// `alongside` 事实折成画面上的带与轨道。纯下标、纯函数——时间线模型与侧栏的迷你运行线共用它，
// 所以规则钉在这里，而不是各自的渲染测试里。
import { describe, expect, it } from "vitest";
import { bandOf, foldPhaseBands, trackOf } from "@/components/workflow-timeline/timeline-bands.js";

describe("foldPhaseBands", () => {
  it("没有 alongside 的时间线没有带", () => {
    expect(foldPhaseBands(3, [[], [], []])).toEqual([]);
    expect(foldPhaseBands(3, [])).toEqual([]);
    expect(foldPhaseBands(0, [])).toEqual([]);
  });

  it("A ∥ B → C：两站折成一条带，各占一条轨道，先声明的在主线上", () => {
    // strand-fanout-two-phases-join：进入 B 时 A 的 fan-out 还在跑。
    expect(foldPhaseBands(3, [[], [0], []])).toEqual([{ from: 0, to: 1, tracks: [[0], [1]] }]);
  });

  it("重叠链 A ∥ B、B ∥ C：一条带两条轨道，A 与 C 同轨（它们并不并行）", () => {
    // strand-overlap-chain：没有哪一条带能同时容下三者的两两并行，贪心着色把 C 放回主线。
    expect(foldPhaseBands(4, [[], [0], [1], []])).toEqual([
      { from: 0, to: 2, tracks: [[0, 2], [1]] },
    ]);
  });

  it("一条主线带两个分支：两个分支彼此不并行，叠在同一条分支轨道上", () => {
    expect(foldPhaseBands(3, [[], [0], [0]])).toEqual([{ from: 0, to: 2, tracks: [[0], [1, 2]] }]);
  });

  it("三者两两并行：三条轨道", () => {
    expect(foldPhaseBands(3, [[], [0], [0, 1]])).toEqual([
      { from: 0, to: 2, tracks: [[0], [1], [2]] },
    ]);
  });

  it("两条带各自折叠，按 from 升序", () => {
    expect(foldPhaseBands(6, [[], [0], [], [], [3], []])).toEqual([
      { from: 0, to: 1, tracks: [[0], [1]] },
      { from: 3, to: 4, tracks: [[3], [4]] },
    ]);
  });

  it("只有一头报出来也算数：`alongside` 先对称化", () => {
    // 进入 B 时 A 还在跑，只有 B 报得出这件事；画面上两站是对等的。
    expect(foldPhaseBands(2, [[1], []])).toEqual([{ from: 0, to: 1, tracks: [[0], [1]] }]);
  });

  it("自指、越界与未列出的引用当没说", () => {
    expect(foldPhaseBands(2, [[0], [1]])).toEqual([]);
    expect(foldPhaseBands(2, [[7, -1, 2], []])).toEqual([]);
    expect(foldPhaseBands(3, [[0, 9], [0], []])).toEqual([{ from: 0, to: 1, tracks: [[0], [1]] }]);
  });

  it("区间里的空档也算成员（鲁棒起见；没有循环时不会出现）", () => {
    expect(foldPhaseBands(3, [[2], [], []])).toEqual([{ from: 0, to: 2, tracks: [[0, 1], [2]] }]);
  });

  it("相交的区间并成一条带", () => {
    expect(foldPhaseBands(4, [[2], [3], [], []])).toEqual([
      {
        from: 0,
        to: 3,
        tracks: [
          [0, 1],
          [2, 3],
        ],
      },
    ]);
  });
});

describe("bandOf / trackOf", () => {
  const bands = foldPhaseBands(5, [[], [], [1], [1], []]);

  it("带外的站没有带，轨道一律是主线", () => {
    expect(bands).toEqual([{ from: 1, to: 3, tracks: [[1], [2, 3]] }]);
    expect(bandOf(bands, 0)).toBeUndefined();
    expect(bandOf(bands, 4)).toBeUndefined();
    expect(trackOf(bands, 0)).toBe(0);
    expect(trackOf(bands, 4)).toBe(0);
  });

  it("带内的站报出它所在的带与轨道", () => {
    expect(bandOf(bands, 2)).toBe(bands[0]);
    expect([1, 2, 3].map((i) => trackOf(bands, i))).toEqual([0, 1, 1]);
  });
});
