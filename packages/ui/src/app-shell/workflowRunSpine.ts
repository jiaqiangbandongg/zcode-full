import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * 脊线的排布（docs/dynamic-workflow/presentation.md「The spine」）：把时间线模型翻译成**每一节**
 * 要画的竖轨，以及节与节之间的**接头行**。纯函数、只有下标与像素，没有 React、没有 DOM——渲染件
 * 照着画就行。
 *
 * 像提交图一样排：左边是轨道，右边是文字，两者不共用一列。轨道 t 的竖轨在 `x = 21 + pitch·t`，
 * 整根脊线的文字从同一列起（`39 + gutter`，`gutter = pitch·(T − 1)`，T 是最宽的带的轨道数）——站在
 * 哪条轨道只挪它的灯，不挪它的字。此前节头只给**自己**的轨道让路（`39 + 12·track`），别的轨道穿过
 * 这一节时就从站名上压过去；轨道多了，主线上的站名一个个被穿。
 *
 * 分叉与汇合发生在两站**之间**，所以各占一行接头（`SPINE_JOINT_PX`），而不是挤进相邻那一节的节头：
 * 每条带都有一行分叉挂在带首节之前、一行汇合挂在带末节之后。此前曲线画在带首节的顶上 13px、
 * 汇合站的顶上或带末节的**底**上——带从第一站起时分叉从清单之外落下来，带到最后一站时汇合画在
 * 末节药丸的下面，接回一条早已结束的主轨。
 *
 * 没有前驱的带，分叉行是**开口**的（`open`）：主轨不从上一站来，而是在行上方 4px 起一个圆头——一个根；
 * 没有汇合站的带，汇合行同样开口，主轨在行下方 4px 收住——一个汇点（卡上的 TAIL / STUB）。
 * Bug 原因（2026-09-24 实机）：第一版只在前驱 / 汇合站存在时才画接头行，strand 改为在自己的灯上
 * 起止；整个工作流就是一条带、每条 strand 只有一站时（四阶段两两并行），每条 strand 长度为零，
 * 脊线上只剩四枚悬空的灯。开口的接头行住在自己的行里，不会压到节头或药丸上，所以一律画出来。
 *
 * 一条 strand 的竖轨从分叉行的底到汇合行的顶。竖轨仍按节拆成上下两截与整节穿过的 `full`，随节的
 * 展开收起自己伸缩，不用量。
 */

/** 接头行的高度。 */
export const SPINE_JOINT_PX = 16;
/** 主线竖轨的 x（中心）。 */
export const SPINE_TRACK_X = 21;
/** 分支轨不多于这么多条时轨距 12，多了收到 8。 */
const WIDE_PITCH_BRANCHES = 4;

/**
 * 一段竖轨：`above` = 节顶到灯，`below` = 灯到节底，`full` = 整节穿过。`stream` = 它是一条流轨的一半：
 * 在节边界让出 chevron 的缺口，`below` 那一半负责把 chevron 画在缺口里（presentation.md「The spine」）。
 */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  position: "above" | "below" | "full";
  stream?: true;
}

/** 一行接头：主轨直穿（墨是跨过它的那条主线段的墨），每条分支一条曲线。 */
export interface SpineJoint {
  main: TimelineInk;
  branches: { track: number; ink: TimelineInk }[];
  /** 开口：分叉行没有前驱（根）、汇合行没有汇合站（汇点）——主轨只在行外伸出一截短头。 */
  open?: true;
}

export interface SpineSection {
  rails: SpineRailPiece[];
  /** 挂在这一节**之前**的分叉行（这一节是某条带的首节）。 */
  fork?: SpineJoint;
  /** 挂在这一节**之后**的汇合行（这一节是某条带的末节）。 */
  merge?: SpineJoint;
}

export interface SpineLayout {
  /** 相邻两条轨道的间距。 */
  pitch: number;
  /** 文字列比没有带时多让出的宽度：`pitch·(T − 1)`；没有带时 0。 */
  gutter: number;
  sections: SpineSection[];
}

export function spineLayout(model: WorkflowTimelineModel): SpineLayout {
  const { bands, rails, stations } = model;
  const widest = Math.max(1, ...bands.map((band) => band.tracks.length));
  const pitch = widest - 1 <= WIDE_PITCH_BRANCHES ? 12 : 8;
  const bandAt = (i: number) => bands.find((band) => band.from <= i && i <= band.to);
  // 双线段只说「这两站并行」，脊线不画；分叉 / 汇合段由接头行画，也不在节里画。流轨与普通段
  // 一样按两半画，只多一个缺口。
  const plain = rails.filter((rail) => rail.kind === undefined || rail.kind === "stream");
  const railOf = (from: number, to: number) =>
    plain.find((rail) => rail.from === from && rail.to === to);
  const plainInk = (from: number, to: number): TimelineInk => railOf(from, to)?.ink ?? "faint";
  const streamMark = (from: number, to: number) =>
    railOf(from, to)?.kind === "stream" ? { stream: true as const } : {};

  const sections: SpineSection[] = stations.map((_, i) => {
    const band = bandAt(i);
    if (band === undefined) {
      // 带外的站：与从前一样，上一站画下半截、下一站画上半截；相邻无边就留空。汇合 / 分叉段的
      // 主线那一条（kind 缺席）照常接在这里，分支那几条归接头行。
      const pieces: SpineRailPiece[] = [];
      const above = plain.find((rail) => rail.to === i);
      const below = plain.find((rail) => rail.from === i);
      if (above !== undefined)
        pieces.push({ ink: above.ink, position: "above", ...streamMark(above.from, i), track: 0 });
      if (below !== undefined)
        pieces.push({ ink: below.ink, position: "below", ...streamMark(i, below.to), track: 0 });
      return { rails: pieces };
    }
    const pieces: SpineRailPiece[] = [];
    band.tracks.forEach((track, t) => {
      const members = track.stations;
      const at = members.indexOf(i);
      if (at >= 0) {
        // 自己的轨道：上半截接前一个成员或分叉行，下半截接后一个成员或汇合行。
        const previous = members[at - 1];
        const next = members[at + 1];
        pieces.push({
          ink: previous === undefined ? track.entry : plainInk(previous, i),
          position: "above",
          ...(previous === undefined ? {} : streamMark(previous, i)),
          track: t,
        });
        pieces.push({
          ink: next === undefined ? track.exit : plainInk(i, next),
          position: "below",
          ...(next === undefined ? {} : streamMark(i, next)),
          track: t,
        });
        return;
      }
      // 别的轨道整节穿过这一节：首个成员之前是进入墨，末个成员之后是离开墨，其间是那一段的墨。
      // 主轨穿过分支站也是这一条。
      const before = members.filter((member) => member < i).pop();
      const after = members.find((member) => member > i);
      const ink =
        before === undefined
          ? track.entry
          : after === undefined
            ? track.exit
            : plainInk(before, after);
      pieces.push({ ink, position: "full", track: t });
    });
    return { rails: pieces };
  });

  for (const band of bands) {
    const main = band.tracks[0]!;
    const branches = (end: "entry" | "exit") =>
      band.tracks.slice(1).map((track, k) => ({ ink: track[end], track: k + 1 }));
    sections[band.from]!.fork = {
      branches: branches("entry"),
      main: main.entry,
      ...(band.pred === undefined ? { open: true as const } : {}),
    };
    sections[band.to]!.merge = {
      branches: branches("exit"),
      main: main.exit,
      ...(band.join === undefined ? { open: true as const } : {}),
    };
  }
  return { gutter: pitch * (widest - 1), pitch, sections };
}
