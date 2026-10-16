# Provider 请求前历史读取性能

## 背景

Agent Runtime 在每个 model step 发送请求前，会多次读取同一份 `MessageHistory`。历史较长时，若每个只读点都通过 `toRuntimeEntries()` 深拷贝全部 entry，会重复分配消息、content block 和 metadata 对象；provider projection 入口再做一次全量深拷贝，又进一步放大同步 CPU 与 GC 成本。

本次只收敛 Runtime 内部的历史读取和 provider projection 拷贝边界，不改变消息顺序、microcompact 结果、cache control、持久化格式、协议或 UI 行为。

## 所有权合同

`MessageHistory` 是 Agent Runtime 内消息历史的唯一权威 owner。entry 写入历史后按不可变值使用；需要改变历史内容时，必须新增 entry、整体 replacement，或只对被修改的 entry 做 copy-on-write，禁止原地修改借出的 entry/message/content。

历史提供三种不同生命周期的读取方式：

| 读取方式                              | 成本          | 适用范围                                  | 合同                                                           |
| ------------------------------------- | ------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `borrowReadOnlyRuntimeEntries()`      | O(1)          | 同步、即时只读                            | 直接返回当前权威 entries；调用方不得写入，也不得跨异步边界持有 |
| `[...borrowReadOnlyRuntimeEntries()]` | O(n) 指针复制 | 需要固定成员集合的异步任务或 compact 边界 | 固定当时的数组成员；entry 仍共享不可变引用                     |
| `toRuntimeEntries()`                  | O(n) 内容克隆 | 需要可变的独立副本或外部防御性快照        | 调用方可以修改返回值，不污染历史                               |

不引入 revision、版本缓存或失效协议。Runtime 在每一个即时读点重新调用 borrow，即可取得该时刻的权威数组。只有明确跨越 `await` 且要求保留调度时边界的代码，才在该读点做一次数组浅快照。

## 时序

```text
同一个 model step

microcompact
  borrow 当前历史 A
  -> projection 只读
  -> 若清理 tool result，以新 entry/message replaceMessages

reminder 判断
  borrow 当前历史 B                 # 重新取，不复用 A
  -> 可能 addAttachment

最终 provider projection
  borrow 当前历史 C
  -> 有 memory update 才用 [...C, update] 创建请求数组
  -> reorder / system projection    # 不改输入 entry
  -> render clone message           # 每次 projection 唯一的内容克隆边界
  -> media/cache-control/request
```

后台 memory agent 和 active compact 会在后续异步步骤继续使用调度时的成员集合，因此它们在入口做数组浅快照。浅快照之后即使 `MessageHistory` append 或 replacement，也不会改变该任务选中的 entry 集合。

这两处浅快照只固定数组成员边界，不会深冻结 entry/message/content：

- Project Memory Extraction/Dream 可能在调度后的其他 turn、compact 或 rewind 之后才消费 `providerEntries`。调度时的数组浅快照负责排除未来追加的消息，真正构建 Memory provider 请求时再由 render 克隆 message/content。
- Active compact 会跨 summary 请求、重试和持久化等异步步骤保留 `activeEntries`。selection、provider render 和最终 `replaceMessages` 分别克隆自己需要拥有的数据。
- 两条链路都依赖同一条不可变性约束：entry 进入 `MessageHistory` 后禁止原地修改其 entry/message/content；后续变化只能通过 append、整体 replacement 或对被修改 entry 的 copy-on-write 完成。违反该约束会让已经调度的异步快照观察到调度后的内容变化。
- 若未来确实需要允许历史 entry 原地变化，必须先恢复调度时的内容级防御性克隆或引入等价的不可变快照机制，不能继续复用当前浅快照合同。

## Projection 拷贝边界

- attachment reorder、mid-conversation system projection 和 legacy reminder 移动只重排引用或创建合成 entry，不得修改输入 entry。
- `renderProjectedEntryToModelMessage` 为每条实际请求消息创建独立 message/content，隔离后续 media、cache-control 和序列化处理。
- microcompact 未触发时直接返回只读输入；触发后才浅拷数组，并只为确实被清理的 tool result 创建新 entry 和新 message。
- `toRuntimeEntries()` 保留原有防御性深拷贝语义，不作为 Runtime 内部普通只读 API 使用。

## 复杂度与边界

优化后，历史读取本身为 O(1)，跨异步边界的成员快照为 O(n) 指针复制，provider message render 仍为必要的 O(n) 内容克隆。microcompact 检查和最终请求各自需要一次 render，但不再在每次 render 前重复克隆 runtime entries；同一个 model step 也不再为各个 reminder 读取重复克隆全历史。

本次不处理 token 估算、context usage 字符串拼接、SQLite 冷恢复或 `ModelRequest` 事件载荷；这些成本需要独立测量，不能用本次改动推断已经消失。

## 验证

- 先用单测锁住防御性 clone、provider projection 隔离和 microcompact 不污染输入的行为。
- borrow API 单测覆盖 append 后重新读取权威值、replacement 后旧 borrow 不再是权威数组，以及防御性 clone 仍可独立修改。
- copy-on-write 单测覆盖只有被清理的 tool entry 更换引用，其他 entry 保持共享。
- 定向测试、`pnpm typecheck` 与 `pnpm lint` 必须通过。
- 使用长历史基准比较优化前后一次发送前 projection 的耗时；基准只作为性能证据，不作为跨机器的硬编码产品阈值。
