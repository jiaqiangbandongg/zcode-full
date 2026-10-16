/**
 * `report` 的上限常量。
 *
 * 与 `world-read-caps.ts` 分成两个模块，是因为两者的**执行侧不同**：world-read 的上限由
 * driver 执行（只有它能"不生产"——让 ripgrep 在 2000 条上停手），report 的上限由**引擎核心**
 * 执行（report 不过 driver，它在核心里落 journal 就结束了）。同一个模块会让读者以为它们由
 * 同一侧强制；数字都是契约这一点则两处相同。
 *
 * 溢出的策略是**失败整个 run**（`ReportCapExceeded`），而不是像 world-read 那样拒绝节点。
 * 这不是严重程度的判断而是**拒绝通道**的事实：`report` 返回 `void`，脚本没有地方 `catch`。
 * 也正因为脚本作者写不出恢复路径，这两个数字必须宽到一份讲道理的脚本永远碰不到。
 */

/**
 * 每个 run 的报告条数、单条序列化字节数与 run 级字节总数上限。数字即契约（见本模块顶部）。
 *
 * 真正受限的资源是**字节**（磁盘上每条存两份：节点行一份、事件一份）；条数与单条字节只是它的
 * 两个代理。三者一起给出最坏情形：一个 run 的 item 至多 1 GiB，磁盘上约 2 GiB。
 */
export const REPORT_CAPS = {
  /**
   * 一个 run 内 `report` 的最大条数。原为 256：那是节点上限（100）还在时按「与之同宽」定的，
   * 节点上限删掉之后，一次「每个任务报一条」的扇出就能合理地撞上它，而撞上的代价是整个 run
   * 失败。条数本身不贵：没有读者会把超出展示界的 item 读进内存（docs/execution-engine.md
   * 「Reading the journal」），磁盘上的总量由 {@link REPORT_CAPS.maxBytesPerRun} 管。
   */
  maxItemsPerRun: 65_536,
  /**
   * 单条 item 序列化后的最大字节数。原为 32 KiB；1 MiB 的界来自一条 item 要能放进一个协议
   * 消息（单帧上限 16 MiB，看板与事件日志一页 4 MiB 且至少带一条），并给读取整条 item 的
   * 读者留出余量——冷回放与 GetWorkflowRun 一次最多读 64 条，即至多 64 MiB 的瞬时内存。
   * 更大的产出该走 `artifact.file`（上限 20 MiB，按块读取）。
   */
  maxItemSerializedBytes: 1024 * 1024,
  /**
   * 一个 run 内全部 item 的序列化字节总数上限。没有它，65,536 条 × 1 MiB 就是 64 GiB 的
   * item（磁盘上 128 GiB）。resume 时由 `sumResultBytes` 从 journal 恢复，跨 resume 连续。
   */
  maxBytesPerRun: 1024 * 1024 * 1024,
} as const;
