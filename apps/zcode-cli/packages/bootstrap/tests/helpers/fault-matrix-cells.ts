/**
 * 故障矩阵的快 / 全两档（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）。
 *
 * 缺省只跑快档（每行至少一格，默认套件与 CI）；`ZCODE_FAULT_MATRIX=full` 展开成 spec 矩阵表
 * 的全部格（`pnpm test:fault-matrix`）。两档共用同一组测试文件、同一张格表，只是列表长短不同。
 */

import type { WireFormat } from "./fake-provider-server.js";
import type { ScriptShape } from "./fault-matrix-scripts.js";

const FAULT_MATRIX_FULL: boolean = process.env.ZCODE_FAULT_MATRIX === "full";

/** 一格的坐标：形状 + wire 格式（缺省 Anthropic，spec 的主格式）。 */
export interface CellCoordinate {
  shape: ScriptShape;
  apiFormat?: WireFormat;
}

/** 快档的格 + 全档才有的格；全档 = 两者并集。 */
export function cells(quick: CellCoordinate[], fullOnly: CellCoordinate[] = []): CellCoordinate[] {
  return FAULT_MATRIX_FULL ? [...quick, ...fullOnly] : quick;
}

/** `it.each` 的标题用：`W4/anthropic-messages`。 */
export function cellName(cell: CellCoordinate): string {
  return `${cell.shape}/${cell.apiFormat ?? "anthropic-messages"}`;
}

/** 每格 `it` 的超时：沙箱子进程 + 重试曲线；spec 的 8 s 是目标，这里给缓冲免得 CI 抖动。 */
export const CELL_TIMEOUT_MS = 30_000;

/** 结算之后再等这么久复查「零请求」（spec 不变式 5）。 */
export const POST_SETTLE_GRACE_MS = 200;
