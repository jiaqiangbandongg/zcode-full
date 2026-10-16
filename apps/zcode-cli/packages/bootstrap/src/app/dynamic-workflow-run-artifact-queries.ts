// ============================================================
// 用户面产物的 journal 读面（DynamicWorkflowRunPort 的三个产物方法共用的取数底座）
// ============================================================
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给**用户**看的产出，不是引擎内部的
// `RunSettlement.artifact`（脚本顶层返回值）。

import type { DwfArtifactItem, DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunArtifactItem } from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";

/**
 * 带产物读面的 journal。签名的**唯一来源**是 adapters 的 {@link DwfRunIntrospectionQueries}
 * （`import type`，运行时零依赖）——与 `DynamicWorkflowIntrospectableJournal` 同一条论证：
 * 这两条查询不在引擎的 {@link JournalStorePort} 上（引擎从不枚举产物、也不联事件表），
 * 只能靠能力探测接上。
 */
interface ArtifactReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listArtifactItems" | "listArtifactRows"> {}

/**
 * journal 是否带产物读面。**刻意是 `supportsRunIntrospection` 的兄弟，而不是把它扩成六条。**
 *
 * 那四条（listRuns / getRunRow / countNodesByStatus / listRecentLogEvents）是一个整体能力：
 * 列表要一条、详情要另外三条，缺一个就该整体降级。产物读面是**后来**长出来的第二个能力，
 * 二者互不依赖——一个只有前四条的 journal（老 adapter 的 dist、只实现了内省的测试替身）应该
 * 继续把 `ListWorkflowRuns` / `GetWorkflowRun` 跑通，只是不提供产物。把它们并成一个探测，
 * 会让这类 journal 上两个早已工作的工具静默消失，而症状离成因极远。
 */
export function supportsArtifactReads(journal: JournalStorePort): journal is ArtifactReadableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.listArtifactItems === "function" &&
    typeof candidate.listArtifactRows === "function"
  );
}

/**
 * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序的一页。
 *
 * 条数与字节两道界由调用方（网关）给定，存储层精确兑现、不再钳，并由它判定 `hasMore`
 * （docs/execution-engine.md「Reading the journal」）。越界 cursor 得到空页而不是错误：翻到
 * 尾巴是正常的翻页结局，不是异常。
 */
export function listArtifactItemsFrom(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  page: { afterSequence?: number; limit: number; maxBytes: number; fields?: readonly string[] },
): { items: DynamicWorkflowRunArtifactItem[]; hasMore: boolean } {
  if (!supportsArtifactReads(journal)) return { items: [], hasMore: false };
  const { items, hasMore } = journal.listArtifactItems(runId, artifactId, {
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit,
    maxBytes: page.maxBytes,
    // 只取字段：值的界是协议常量，存储层不自己定。
    ...(page.fields === undefined
      ? {}
      : {
          fields: {
            paths: page.fields,
            maxValueBytes: WORKFLOW_ARTIFACT_LIMITS.maxFieldValueBytes,
          },
        }),
  });
  return { items: items.map(toArtifactItem), hasMore };
}

/**
 * 存储层的一行 → 端口的一条。字段一一对应，刻意**不做预览序列化**：看板的纯函数要按字段
 * 路径（`ChartSpec.x.field` 形如 "timing.after"）取数，拿到一段 pretty JSON 文本就取不出来
 * 了。单条由写入侧的 `REPORT_CAPS.maxItemSerializedBytes` 有界，一页由 `maxBytes` 有界。
 */
function toArtifactItem(row: DwfArtifactItem): DynamicWorkflowRunArtifactItem {
  return {
    sequence: row.sequence,
    siteId: row.siteId,
    ordinal: row.ordinal,
    ...(row.fields === undefined ? { item: row.item } : { fields: row.fields }),
  };
}

/**
 * 一行 artifact 节点认领的产物 id。
 *
 * 优先读 `dwf_node.artifact_id` 列（较新迁移添加的、带索引的那一列）；记录里的 `id` 只是兜底。
 * 两者由引擎在同一次 putNode 里写下、恒相等，但列为 NULL 的老行不该让整行读不出来。
 */
export function artifactRowId(row: NodeRecord): string | undefined {
  if (typeof row.artifactId === "string" && row.artifactId.length > 0) return row.artifactId;
  const record = row.result;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const id = (record as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
