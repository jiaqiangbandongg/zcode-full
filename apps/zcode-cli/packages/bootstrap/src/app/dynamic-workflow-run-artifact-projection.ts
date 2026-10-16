// ============================================================
// Dynamic Workflow Run：用户面产物的归并投影（journal 行 → 端口的 artifacts）
// ============================================================
// dynamic-workflow-run-observation.ts 顶到 oxlint max-lines 上限（400 行），把整段
// 产物归并（{@link artifactsOf} 与它的私有解码器）拆到本文件。观察面仍原样再导出它，四个
// 调用点（快照 / getRunDetail / listArtifacts / saved-workflows 中枢）因此一行都不用改。
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` **发布给用户看的产出**（journal
// `kind = "artifact"` 的行），不是引擎内部的 `RunSettlement.artifact`（脚本顶层返回值，端口上
// 叫 `output` / `result`）。同一个词两个义。

import type { DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifactVersion,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";

/**
 * 终态快照与 `getRunDetail` 上的 `artifacts`：**用户面产物**。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出（journal `kind = "artifact"`
 * 的行），**不是**引擎内部的 `RunSettlement.artifact`（脚本顶层返回值，端口上叫 `output` /
 * `result`）。同一个词两个义。
 *
 * 取数与观察面的 `reportsOf` 同规——journal 是版本历史的**持久家**（memory-only 的
 * `workflowRuns.artifacts` 投影只带最新版元数据、冷恢复后为空），而 failed / cancelled 的 run
 * 一样要交出它已经发布的产物（一个死在第 12 步的 run 仍然交付了前面那张图）。
 *
 * `listArtifactRows` 不在引擎的 {@link JournalStorePort} 上（引擎从不枚举、不聚合），所以按
 * 房规**能力探测**接上：缺席即整字段缺席，而不是抛错——注入的测试 store 与不带内省查询的
 * 实现都必须继续可用。
 *
 * 归并规则：
 *   - 只收 `completed` 的行。失败的发布不占 id、不占版本号，把它算进版本
 *     历史会让「第 3 版」在 UI 上指向一个从未存在的字节。
 *   - 同 id 的行按 `version` 升序；`title` / `contentType` / `sourcePath` / `spec` 等提到
 *     顶层的是**最新版**的值，方便只关心「现在是什么」的读者不必自己翻 versions。
 *   - `itemCount` = 打了这个 id 标签的 `report` 行数（预置看板的数据量，也是 UI 的刷新信号）。
 *     内容产物恒 0。
 *
 * 零件时整字段缺席——空数组读起来像「跑过但没产出」，而缺席才是「这个 run 没有产物这个概念」。
 */
export function artifactsOf(
  runId: string,
  journal: JournalStorePort,
): { artifacts?: readonly DynamicWorkflowRunArtifact[] } {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.listArtifactRows !== "function") return {};
  const rows = candidate.listArtifactRows(runId);
  if (rows.length === 0) return {};

  // id → 版本累积器。插入顺序 = 首次出现顺序，也就是端口契约上 `artifacts` 的顺序。
  const byId = new Map<
    string,
    { kind: DynamicWorkflowRunArtifactKind; versions: DynamicWorkflowRunArtifactVersion[] }
  >();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const record = row.result;
    if (record === null || typeof record !== "object") continue;
    const version = artifactVersionOf(record as Record<string, unknown>);
    if (version === undefined) continue;
    const id =
      typeof row.artifactId === "string" && row.artifactId.length > 0
        ? row.artifactId
        : stringField(record as Record<string, unknown>, "id");
    const kind = artifactKindOf((record as Record<string, unknown>).kind);
    if (id === undefined || kind === undefined) continue;
    const bucket = byId.get(id);
    if (bucket === undefined) byId.set(id, { kind, versions: [version] });
    else bucket.versions.push(version);
  }
  if (byId.size === 0) return {};

  // 标签计数只在**真有预置看板**时才查：内容产物的 `itemCount` 恒 0。中枢一页 50 行、每行调一次
  // 本函数，这条短路让没有看板的 run 连那条 group by 都不发。
  const needsTally = [...byId.values()].some((bucket) => PRESET_ARTIFACT_KINDS.has(bucket.kind));
  const itemCounts = needsTally ? tagItemCounts(runId, journal) : undefined;
  const artifacts = [...byId].map(([id, bucket]) => {
    const versions = [...bucket.versions].sort((left, right) => left.version - right.version);
    // 最新版 = 版本号最大的那一条。空 bucket 不可能（构造时至少一条）。
    const latest = versions[versions.length - 1]!;
    // 旗子按 id 粘着（引擎保证后续版本都带），任一版带上即算——老 CLI 落的行没有这个键。
    const primary = versions.some((version) => version.primary === true);
    return {
      id,
      kind: bucket.kind,
      ...(latest.title === undefined ? {} : { title: latest.title }),
      ...(latest.description === undefined ? {} : { description: latest.description }),
      ...(latest.contentType === undefined ? {} : { contentType: latest.contentType }),
      ...(latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath }),
      ...(latest.spec === undefined ? {} : { spec: latest.spec }),
      version: latest.version,
      versions,
      itemCount: itemCounts?.get(id) ?? 0,
      ...(primary ? { primary: true as const } : {}),
    } satisfies DynamicWorkflowRunArtifact;
  });
  // 交付物带头，其余保持首次发布顺序：
  // 顺序在这里定一次，快照 / GetWorkflowRun / 中枢 / v4 查询都从这里读，任何上界都砍不到它。
  // `Array.prototype.sort` 在 ES2019 起稳定，所以非 primary 之间的相对顺序不动。
  artifacts.sort((left, right) => Number(right.primary === true) - Number(left.primary === true));
  return { artifacts };
}

/**
 * 标签 report 行的按 id 计数（`kind = "report" ∧ artifact_id = ?`——看板的数据量）。
 *
 * SQLite 实现带 `countTaggedReports`（`group by` 下推，行一条都不读）；不带它的 store（引擎的内存
 * 实现、测试替身）退回读 report 行的**元数据**（不带 item）在内存里数——两条路给同一个数。修复
 * 原因：此前这里把整张节点表连同每条 report item 读进内存再数（docs/execution-engine.md
 * 「Reading the journal」）。
 */
function tagItemCounts(runId: string, journal: JournalStorePort): ReadonlyMap<string, number> {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.countTaggedReports === "function")
    return candidate.countTaggedReports(runId);
  const counts = new Map<string, number>();
  for (const node of journal.listNodes(runId, { kinds: ["report"], withResult: false })) {
    if (node.artifactId === undefined) continue;
    counts.set(node.artifactId, (counts.get(node.artifactId) ?? 0) + 1);
  }
  return counts;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/** 预置看板的四个成员：只有它们会被标签 `report` 喂数据，内容产物的 `itemCount` 恒 0。 */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "chart",
  "table",
  "metrics",
  "board",
]);

function artifactKindOf(value: unknown): DynamicWorkflowRunArtifactKind | undefined {
  return typeof value === "string" && ARTIFACT_KINDS.has(value)
    ? (value as DynamicWorkflowRunArtifactKind)
    : undefined;
}

/**
 * `dwf_node.result_json` 上的 `ArtifactVersionRecord` → 端口的版本项。行的形状来自引擎与
 * driver，但它经过一次 JSON 往返又可能来自更老的 CLI，所以每个字段都防御性收窄：`version`
 * 不是正整数就整行丢弃（一个没有版本号的版本在 UI 上无法定位、也无法读字节）。
 */
function artifactVersionOf(
  record: Record<string, unknown>,
): DynamicWorkflowRunArtifactVersion | undefined {
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const bytes = record.bytes;
  // driver 恒写 `publishedAt`，引擎的类型上它才是可选的。缺席时给 0 而不是丢行：
  // 一个没有时间戳的产物仍然可看，而丢掉它会让版本号在 UI 上出现空洞。
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : 0;
  const title = stringField(record, "title");
  const description = stringField(record, "description");
  const contentType = stringField(record, "contentType");
  const uri = stringField(record, "uri");
  const sourcePath = stringField(record, "sourcePath");
  return {
    version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}),
    ...(uri === undefined ? {} : { uri }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    publishedAt,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
