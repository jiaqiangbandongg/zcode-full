# Bugfix 02：Provider 拖拽松手后回弹再跳转

> 状态：已完成（自动化验证通过；macOS Electron 手工复验待本轮开发包）
>
> 日期：2026-08-27
>
> 来源：macOS ZCode Provider Settings 手工体验与实现链路审计

## 1. 问题

Provider 设置页拖动自定义 Provider 后，拖拽过程本身能够正确跟手，但松开鼠标时列表会先回到拖拽前的位置，
随后再跳到目标位置。

Model 排序经过完整调用链审计后不属于这个问题：`SortableProviderModelList` 的上层
`InlineEditableProviderCard` 会在异步保存前同步执行 `setModels(next)`，已经拥有正确的乐观投影。本 Bugfix 不给
Model 再叠加第二层 Pending 状态。

用户观察到的顺序是：

```text
拖到目标位置
      |
      v
松手后回到旧位置
      |
      v
稍后跳到目标位置
```

最终配置通常能够保存成功，因此这不是排序算法算错，也不是 Personal Config 丢失，而是拖拽临时状态和异步
持久化事实之间出现了一个可见的旧状态窗口。

## 2. 根因

`dnd-kit` 在拖拽期间通过 `transform` 临时移动 Sortable 元素。松手后，它会结束本次拖拽并清除临时
`transform`；此时页面仍然按照父组件传入的旧 `navigationGroups` / `modelIds` 渲染。

当前 `onDragEnd` 只计算新顺序并调用异步保存，没有同步改变用于渲染的顺序：

```text
Pointer Up
    |
    +--> dnd-kit 清除 transform
    |       |
    |       `--> Renderer 仍持有旧 Settings View
    |                   |
    |                   `--> 元素按 transition 回到旧位置
    |
    `--> reorderPersonalProviders
             |
             v
        Personal Config 文件锁与原子写入
             |
             v
        Registry refresh
             |
             v
        Provider Settings View onDidChange
             |
             v
        React 收到新顺序并重新排列 DOM
```

因此界面先展示了“拖拽临时状态结束后的旧事实”，再展示“持久化完成后的新事实”。Provider 重构把排序写入
收口到 Personal Config、Registry 和正式 Settings View 后，这段正确但异步的链路使旧问题更明显。

这不是以下问题：

- 不是 `arrayMove` 的目标索引错误；
- 不是整个 Provider 行作为拖拽区域导致；
- 不是 CSS transition 本身错误；
- 不是 Registry 或 Personal Config 应该改成同步 IO；
- 不是需要新增另一份 Provider Config 或绕开正式 Settings Service。

## 3. 修复原则

持久化权威保持不变：

```text
Personal Provider Config
        |
        v
Provider Registry / Settings View
        |
        `--> 最终确认的 Provider 顺序
```

UI 增加的只是一次交互尚未确认期间的乐观投影：

```text
正式 Settings View 顺序 -------------------------+
                                                  |
Drag End --> Pending Reorder（瞬时 UI 状态） -----+--> 当前渲染顺序
                    |
                    +--> 保存成功且 View 已对齐 --> 清除 Pending
                    |
                    `--> 保存失败 ---------------> 回滚到正式 View
```

`Pending Reorder` 不落盘、不跨页面、不进入 Registry，也不参与 Model Selection 或模型执行。它只解决一次
用户操作从松手到正式 View 确认之间的视觉连续性，不形成第二份领域事实。

## 4. 方案

### 4.1 松手时同步提交乐观顺序

- `onDragEnd` 先根据当前实际渲染顺序计算完整目标顺序；
- 在同一个事件处理中同步更新 Pending Reorder，使 React 在 `dnd-kit` 清除 transform 时已经按目标顺序渲染；
- 随后通过现有 `ProviderSettingsService` 保存，不绕开 Facade、Config Repository 或 Registry；
- 不通过关闭 transition、延迟 Drag End、保留假的 transform 或强制操作 DOM 掩盖旧状态窗口。

### 4.2 以正式 View 完成确认或回滚

- Settings View 到达并与本次目标顺序一致后，清除对应 Pending Reorder；
- 保存失败时，仅回滚仍属于该次操作的 Pending Reorder，并使用 UI logger 记录失败原因；
- 旧请求迟到时不能覆盖用户后来发起的新排序；
- 页面卸载或切换 Environment 时直接丢弃 Pending Reorder，重新以目标 Environment 的正式 View 为准。

### 4.3 连续拖拽保持最终顺序一致

用户在第一次保存完成前再次拖动时：

- 新顺序必须基于当前乐观顺序计算，不能回读旧 View；
- 排序写入按交互发生顺序串行，或者合并为“保存当前最新目标顺序”；
- 任意较早的成功、失败或 View 推送都不能清除较新的 Pending Reorder；
- 最终没有在途操作时，UI 顺序、Personal Config 和 Settings View 必须一致。

### 4.4 不改变 Model 排序

- Model 排序继续由 `InlineEditableProviderCard` 在提交前同步更新本地 `models`；
- 保存失败仍由该表单 owner 回滚并展示既有保存错误；
- 不把 Provider Pending Reorder 泛化成领域层通用排序 DTO；
- 增加回归断言，证明 Model 现有链路没有被 Provider 修复破坏。

## 5. 状态所有权

| 状态                     | Owner                     | 生命周期                             | 用途                 |
| ------------------------ | ------------------------- | ------------------------------------ | -------------------- |
| `providerOrder`          | Personal Config           | 持久化                               | 用户排序权威         |
| Settings View 中的顺序   | Provider Settings Service | Registry revision                    | UI 的正式读取事实    |
| Pending Provider Reorder | Provider Settings UI      | 单页、单 Environment、单次或连续交互 | 松手后的即时视觉投影 |
| `dnd-kit transform`      | Sortable 组件             | 一次 pointer/keyboard drag           | 拖拽进行中的位移     |

不把 Pending Reorder 写入 Zustand 全局设置状态；它不需要跨窗口同步，也不影响 Desktop continuous、Mobile
replayable、Remote Workspace、Session Selection、队列或恢复语义。

## 6. 测试

先写失败测试，再实现修复：

| Case    | Setup                                | Action             | Assertions                                     |
| ------- | ------------------------------------ | ------------------ | ---------------------------------------------- |
| BF02-01 | Provider 保存 Promise 受控延迟       | 拖动并松手         | Promise 完成前已按目标顺序渲染，不回旧位置     |
| BF02-02 | Provider 保存失败                    | 拖动并松手         | 先乐观显示；失败后回滚正式顺序并记录错误       |
| BF02-03 | 第一次 Provider 保存未完成           | 连续拖动两次       | 第二次基于乐观顺序；迟到结果不覆盖最终目标     |
| BF02-04 | 新 Provider Settings View 与目标一致 | 完成保存           | Pending 被清除，后续正式刷新不发生二次跳动     |
| BF02-05 | Model 保存 Promise 受控延迟          | 拖动 Model 并松手  | 现有表单乐观顺序保持稳定，不新增第二层 Pending |
| BF02-06 | 键盘 Sortable 操作                   | 完成 Provider 重排 | 与 pointer 拖动拥有相同的乐观更新和确认语义    |
| BF02-07 | 切换 Environment / 页面卸载          | 存在 Pending       | 不把旧 Environment 的顺序带入新页面            |

保留现有纯函数排序测试；新增交互测试必须控制保存 Promise，并断言“保存完成前”的 DOM 顺序，不能只等待最终
View 后验证结果，否则无法防止该回归再次出现。

## 7. 完成门禁

- Provider 松手后直接停在目标位置，Model 现有行为无回归；
- 慢文件 IO、慢 Registry refresh 下不出现旧顺序闪回；
- 保存失败可回滚，连续拖拽满足 latest intent；
- Personal Config 与 Settings View 仍是唯一持久化和正式读取权威；
- 不增加同步文件 IO、DOM 手工排序、固定延时或第二套 Config；
- Provider Settings 定向测试、UI typecheck、根 `typecheck`、`lint` 和格式检查通过；
- macOS Electron 运行态以人为放慢保存链路或连续拖拽复验视觉连续性。
