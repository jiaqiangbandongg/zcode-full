# ZCode CUA SDK v3 API 设计（模型可见面，仅 CUA）

> 状态：Draft，待评审
> 日期：2026-09-10
> 上游方案：[ZCode CUA 重构技术方案：从 30 个 MCP 工具到 node_repl 代码执行](https://internal-docs.example.invalid/redacted)
>
> **修订记录**
> - v2 draft（同日，废弃）：ZCode 风格绑定对象，方法名/签名自行设计。
> - v3 draft（同日，废弃）：绑定对象 API 固化为最小模型面，但 ZCode 独有能力仅「下沉」到
>   逃逸口，30 个工具全部保留。
> - **v3.1（本文）**：评审推翻「下沉即可」。**模型可见成员固定为既有 17 个交互面成员 +
>   `requestAccess` + `stop`；新增能力先问能不能删；不能删且不能被组合替代的，只允许
>   出现在可选选项键或尾部可选参数**。能被组合或 SDK 机制替代的能力，
>   从工具层直接删除，不留逃逸口；失去消费者的 **broker 方法与原生实现一并删除**，
>   不保留「以备将来」的原语。`zoom` 一并删除。新增「compact 无条件带 actions、
>   删除 detail」的独立改动。工具面 **30 → 14**，broker 协议 **63 → 49**，详见 §3。
>   评审确认接受两项能力收缩：「按住 → 观察 → 释放」与剪贴板读取。

本文范围：重构 `@zcode/cua` SDK 的模型可见 API、其内部分层，以及**工具面与 broker 协议的一次显式瘦身**。
不改 Helper 鉴权（M1）、Helper 生命周期（M2）、AX 规范化（M3）、node_repl MCP 工具面；
但**会 bump broker IPC 协议版本**（1 → 2）以删除失去消费者的方法，走 M2 已有的
`version_mismatch` fail-closed 路径（§7.3）。
**不融合 Browser Use**：`agent.browsers` / `browser-use-plugin` 零改动。

---

## 0. TL;DR

### 0.1 目标形态

模型看到的 CUA API 是一个 camelCase 的 `cua` 全局对象（不含 browser 半边）。
模型可见成员固定为既有 17 个交互面成员 + `requestAccess` + `stop`，
签名、方法名、参数名、选项名、返回类型见 §2：

```js
const state = await cua.getState();            // 展示 app 清单
const app   = await cua.getApp("Notes");       // 绑定 + 展示初始 AX 全树
await app.click(42);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();                         // 自动展示；返回 string
```

模型可见面收敛到**两个安全方法 + 四个可选选项袋**，没有任何附加成员。

### 0.2 三处数量

| 维度 | 现状 | v3.1 |
|---|---|---|
| 模型可见工具 / 方法 | 30 个 MCP 工具 | 19 个 SDK 成员（17 个交互面成员 + `requestAccess` + `stop`） |
| 底层工具面（`cua.computer`） | 30 | **14**（删 16，§3.2-3.5） |
| broker 协议方法 | 63 | **49**（删 15 + 新增 `paste`；再删 6 个测试探针可到 43，§3.6） |
| 模型面附加成员 | —— | **0** |
| 模型面附加选项 | —— | 4 个选项袋，共 5 个键（`modifiers` / `strategy` / `holdSeconds`） |

### 0.3 两处特殊语义（必须在模型文档里显式告知）

1. **Worker 生命周期**：node_repl 每次 `js` 都是 fresh Worker（2026-07-28 无状态规格），
   `const app` 活不到下一个 cell，模型文档不能教模型用 `const` 存跨调用句柄。缓解见 §5.1。
2. **`possibly_sent` 防重放**：动作公开签名是 `Promise<void>`，「可能已下发」的信息
   不占签名位，藏进错误对象。见 §5.2。

---

## 1. 模型面最小化原则

> **R1｜模型可见成员固定。** 模型可见成员固定为既有 17 个交互面成员 + `requestAccess` + `stop`。
> 不做「更好的命名」，不加位置参数，不改返回类型。
>
> **R2｜新增能力，先问能不能删。** 判据不是「有用吗」，而是
> **「能不能被两行 JS、一次组合调用，或 SDK 内部机制替代」**。能替代的删掉；
> 不能替代且有证据支撑的，只允许出现在既有方法的可选选项键或尾部可选参数里。
>
> **R3｜安全语义只藏不删。** `state_id` 强校验、frame 精确栅格、`possibly_sent`、
> controller lease、kill switch 全部保留，但改为内部字段或类型化错误，不占签名位。

R2 是 v3.1 相对 v3 draft 的核心变化。上一版把独有能力一律塞进
`cua.computer` 逃逸口，理由是「逃逸口零模型成本」。这个理由只对模型成立，
对代码库不成立：每个工具都要养一份 schema、一份 handler、一份 tier 表项、
一份 annotation、一份 e2e oracle、以及三平台各一条 act-verify 场景。
30 个工具里有一半是「30 个 MCP 工具」时代的产物 —— 那时每多一次往返就多一个模型回合，
所以把重复操作压成参数是对的；改成代码执行后，这些参数和工具变成纯粹的维护负担。

---

## 2. 模型可见面

### 2.1 完整 TypeScript 声明

`// + ZCode` 表示按 R2 附加的项（只能是可选键 / 尾部可选参数）。

```ts
// ───────────────────────────────────────────── 标量
type Vec2 = [x: number, y: number];
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
type SelectionType = "text" | "cursor_before" | "cursor_after";

interface ObservationOptions {
  /** Display the observation to the model. Defaults to true. */
  emit?: boolean;
}
interface StateOptions extends ObservationOptions {
  disableDiffing?: boolean;
}                                                   // ← detail 已删除（§3.3）
interface ClickOptions {
  mouseButton?: MouseButton;
  clickCount?: number;
  modifiers?: string;                               // + ZCode（"cmd+shift"）
  strategy?: "auto" | "a11y" | "event";             // + ZCode（默认 auto）
}
interface SelectTextOptions {
  prefix?: string;
  suffix?: string;
  selectionType?: SelectionType;
}
interface PasteOptions {
  format?: "text" | "md" | "html";
}                                                   // ← restoreClipboard 已删除（§3.4）
interface StateAndScreenshot {
  state: string;
  screenshot?: Uint8Array;
}
interface PressKeyOptions {                         // + ZCode（整个第二参数是附加的）
  holdSeconds?: number;                             //   > 0 时走 hold_key
  strategy?: "auto" | "a11y" | "event";
}                                                   // ← repeat 已删除（§3.4）
interface ScrollOptions {                           // + ZCode
  strategy?: "auto" | "a11y" | "event";
}                                                   // ← amount 已删除（§3.4）
interface DragOptions {                             // + ZCode
  modifiers?: string;
  strategy?: "auto" | "a11y" | "event";
}

// ───────────────────────────────────────────── 交互面（12 个成员）
/** The shared interaction surface of an explicitly bound app. */
interface Target {
  /** Display and return the current accessibility state. */
  getAXState(options?: StateOptions): Promise<string>;
  /** Display and return the screenshot. */
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  /** Display and return accessibility state and its screenshot, when available. */
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;

  paste(text: string, options?: PasteOptions): Promise<void>;
  click(target: number | Vec2, options?: ClickOptions): Promise<void>;
  drag(from: Vec2, to: Vec2, options?: DragOptions): Promise<void>;
  pressKey(key: string, options?: PressKeyOptions): Promise<void>;
  scroll(target: number | Vec2, direction: Direction,
         pages?: number, options?: ScrollOptions): Promise<void>;
  selectText(elementIndex: number, text: string,
             options?: SelectTextOptions): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}
// ← Target.zoom 已删除（§3.2）。附加成员数量：0。

/** 无任何额外文档化成员。 */
interface App extends Target {}

// ───────────────────────────────────────────── 数据
interface AppInfo {
  // listApps 直通 producer 的 list_applications wire 形状（工具层不做映射）。
  pid: number;
  name: string | null;
  bundle_id: string | null;                         // macOS bundle id / Windows AUMID
  active: boolean;                                  // 是否 frontmost
}
interface State {
  apps: AppInfo[];
  // ZCode 不融合 BUA，该键**不存在**（§5.3）。
}

// ───────────────────────────────────────────── 根对象
declare const cua: {
  getState(options?: ObservationOptions): Promise<State>;
  getApp(target: string): Promise<App>;
  listApps(options?: ObservationOptions): Promise<AppInfo[]>;
  computer: Computer;                               // 内容见 §3.5

  /** + ZCode：安全面。刻意放顶层，不藏进逃逸口。 */
  requestAccess(capabilities?: string[]): Promise<AccessStatus>;
  stop(reason?: string): Promise<void>;
};
```

### 2.2 成员清单与选项差异

`Target` 12 个成员全部同名同签，差异只在选项袋：

| 成员 | 差异 |
|---|---|
| `getAXState` / `getScreenshot` / `getAXStateAndScreenshot` | 无 |
| `paste` | 无 |
| `click` | `ClickOptions` 多 `modifiers` / `strategy` |
| `drag` | 多尾部可选参数 `DragOptions` |
| `pressKey` | 多尾部可选参数 `PressKeyOptions` |
| `scroll` | 多尾部可选参数 `ScrollOptions`（仅 `strategy`） |
| `selectText` / `setValue` / `typeText` / `performSecondaryAction` | 无 |

`cua` 根对象：`getState` / `getApp` / `listApps` / `computer` 四项构成基础面，
`State` 无 `browsers` 键；附加 `requestAccess` / `stop`。
browser 半边（`browsers` / `getBrowser` / `createBrowserTab` / `getTab` /
`listBrowsers` / `listTabs`）**不存在**。

### 2.3 语义规则（不只是签名）

模型可见语义按 `apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md` 定义，不做随意化改动：

- **观察方法自动展示结果**，动作方法不展示。`{emit:false}` 关闭。
- **绑定即观察**：`cua.getApp(...)` 返回前展示该 app 的**全量** AX 树。
- **AX 文本默认 diff**，`{disableDiffing:true}` 取全树；「若一次独立 `getAXState()`
  报告无变化，不要在没有中间动作的情况下立即重复它」。
- **内建 settle，禁止模型 sleep**（约 1s，有 loading 迹象时递增到 5s）。
- **索引时效**：动作后重新 `getAXState()` 再决定下一步。
- **批处理**：确定性动作 + 末尾一次 `getAXState()` 放进同一个 cell。
- **失败即抛**：动作 `Promise<void>`，成功无返回值。
- **首用文档渐进披露**：第一次任意调用展示 API 全文。
- 「Attempting an action is not completion: verify that the returned
  UI state visibly shows the requested result」原样保留。

---

## 3. 工具面瘦身：30 → 14

### 3.1 判据

每个工具问两个问题，全否才留：

1. 能被一次组合调用替代吗？
2. 能被两行 JS 或 SDK 内部机制（settler / 绑定 / paste 组合）替代吗？

### 3.2 整簇删除：全屏像素子系统（5 个）

`screenshot`（全屏）、`zoom`、`list_displays`、`switch_display`、`cursor_position`。

这五个是一个**互相咬合的簇**，是 19 个 pixel-CUA 工具时代的遗留：
`screenshot` 抓「由 `switch_display` 选中的那块屏」，`cursor_position` 的返回值里
带 `selected_display`（`electronNativeBackend.ts:1036`），`zoom` 从保留的栅格里裁剪。

删得掉的关键证据：**per-app 捕获不依赖已选显示器**。
`axReadOnly.ts` / `axSkyshot.ts` 里没有任何 `selectedDisplay` 引用，
显示器选择状态只被 `screenshot` 和 `cursor_position` 消费。
所以删掉这一簇不影响 `getApp` / `getAXState` / `app.getScreenshot()`（per-app 路径）。

`zoom` 单独说明。它不是一项能力，是**对自身有损压缩的补偿**：ZCode 截图走 JPEG
质量阶梯，压不进字节预算就链式缩小尺寸（`jpeg-budget.ts:124`），小字会糊，
所以需要放大重拍。
删除它有一个额外收益：`frame-registry.ts:31` 写明精确栅格字节
「retained **only** for frame-bound zoom」，删掉 zoom 后 frame registry 不再需要
在内存里留住每一张交付过的栅格。

**必须保留的内部设施**：`display-topology` / `display-provenance`
被 `axReadOnly.ts` 与 `electronInputHandlers.ts` 用于 DIP 坐标换算和输入派发，
**留**。删的只是「选屏状态」这一层（`electronDisplaySelection.ts` 的
`selectedDisplayId`、`session.ts` 的同名状态）。
`screen_size` broker 方法的存留待实现时核（`electronNativeBackend.ts:999`，
疑似只被内部/诊断使用）。

**接受的代价**：模型失去「看整个桌面」的能力。替代路径是
`listApps()` + `getApp()`；macOS 上菜单栏附件、通知中心、Dock 都是有 AX 的进程，
`getApp` 能覆盖。多显示器场景下 per-app 捕获按窗口所在屏工作，无需选屏。

### 3.3 删除 `detail`，compact 无条件带 actions（独立的缺陷修复）

`detail:"full"` 相对 compact 只多两样：`bounds` 和 `actions`
（`format.ts:135-139`）。而：

- `bounds` 是模型**被禁止使用**的。`SKILL.md:465` 原话：bounds 是
  global screen-point 诊断信息，不是栅格像素，「**never** copy them into a
  coordinate target」。
- `actions` 是 `performSecondaryAction` **唯一**合法取值来源，
  SKILL 又要求「只用元素已声明的 action，不要猜」。

默认档位是 compact。也就是说**默认档藏起了语义动作必需的数据，
想拿到就必须切到同时倾倒禁用字段的档位**。这不是一个开关该有的形状。

改动：compact 无条件带 `actions`、永不带 `bounds`，`detail` 参数整个删除
（工具层与 `StateOptions` 都删）。这一条可以作为一个独立的小 PR 先落地。

### 3.4 折叠进选项：4 个点击变体 + hold_key（5 个）

| 删除的工具 | 替代 | broker 侧 |
|---|---|---|
| `double_click` | `click(t, {clickCount: 2})` | `click` 已带 button + clicks，零改动 |
| `triple_click` | `click(t, {clickCount: 3})` | 同上 |
| `right_click` | `click(t, {mouseButton: "right"})` | 同上 |
| `middle_click` | `click(t, {mouseButton: "middle"})` | 同上 |
| `hold_key` | `pressKey(key, {holdSeconds})` | `hold_key` / `hold_key_to_app` 留作原语 |

同批删除的**参数**：

- `key` 的 `repeat` —— `for (let i = 0; i < 3; i++) await app.pressKey("Down")` 两行替代。
  它还自带三条特殊规则（负数拒绝、`0` 是 no-op、clamp 到 1..100），
  在 `keyboard-runtime.ts` 里占了专门的分支和文案。
- `scroll` 的 `amount` —— `pages` 更语义化。
- `paste` 的 `restoreClipboard`（v3 draft 里我自己加的）—— paste 语义
  **就是**粘完还原，给开关等于允许模型污染用户剪贴板。

### 3.5 工具与 broker 方法一起删除（6 个工具）

| 删除的工具 | 为什么 | 对应 broker 方法 |
|---|---|---|
| `wait` | 有 settler 之后调 wait 就是在对抗 SDK；内建 settle 明令禁止 sleep | 无（本地 sleep） |
| `read_clipboard` | AX 读不到的内容属于 fallback of fallback | `read_clipboard` **删** |
| `write_clipboard` | 被 `paste` 取代 | `write_clipboard` **删** |
| `mouse_move` | hover 出 tooltip 罕见 | `move_to` **删** |
| `left_mouse_down` | 未配对的按下有输入持有泄漏面 | `mouse_down` **删** |
| `left_mouse_up` | 同上 | `mouse_up` **删** |

`mouse_move` + `left_mouse_down` + `left_mouse_up` 三者唯一的真实组合用途是
「按住 → 观察 → 释放」（拖到文件夹上悬停展开、滑块微调）。**v3.1 不暴露按住类原语**，
`drag(from, to)` 是唯一拖拽入口。

顺带收益：模型再也拿不到未配对的 `left_mouse_down`，
`InputHoldRegistry` + `pointerHoldGuard` 的**模型侧泄漏面整体消失**
（`hold_key` 仍存活，所以内部 cleanup 保留 `cancel_input_holds`）。

**已接受的能力收缩（评审确认）**：悬停展开式拖放、滑块微调、剪贴板读取三项直接放弃。
不保留 broker 原语「以备将来」—— 要恢复就重新加方法、加原生实现、bump 协议版本，
成本明确写在 §9。

### 3.6 broker 协议瘦身：63 → 49

删除工具层之后，一批 broker 方法失去全部消费者。评审决定**一并删除，不留原语**。

**已经是死方法（与本次重构无关，早就没有消费者）：6 个**

| 方法 | 现状 |
|---|---|
| `screen_size` | src 内零调用点 |
| `get_skyshot` | src 内零调用点（per-app 截图实际走 `capture_app`） |
| `click_element_at_point` | src 内零调用点（坐标穿 AX 实际走 `element_at_point` + `element_press`，见 `target-utils.ts`） |
| `key_down` / `key_up` | 只有 Helper 侧实现（`electronInputHandlers.ts:4284-4301`），无调用方 |
| `type_text_into_current_focus` | 同上（`:4208-4223`） |

**随工具删除而失去消费者：9 个**

`screenshot`、`list_displays`、`set_display`、`cursor_position`、`move_to`、
`mouse_down`、`mouse_up`、`read_clipboard`、`write_clipboard`。

**新增：1 个**

`paste` —— 原生实现（Helper 内 NSPasteboard 保存 / 写入 / 发粘贴键 / 还原），
见 §6.6。是原生 Helper 动作，不是 host 侧用剪贴板原语拼的。

**可选一并清理：6 个测试专用探针**

`pip_live_probe_start_test_panel` / `_window_bounds` / `_drag_panel` /
`_move_test_panel` / `_sample_ownership` / `_initial_hit_surface`。
消费者只有 `scripts/pip_live_*` 与 `test/pip-live-*` —— 六个**只为测试存在的方法
活在生产 broker 协议里**。建议移到 DEBUG 构建门控后，或改由测试专用入口驱动面板。
做掉之后 63 → 43。

**协议版本 bump 是设计内操作**：`ipcVersion.ts` 的注释原文写明
「语义变更（**增删方法**、请求/响应形状、鉴权模型）必须 bump」，
且新旧错配走 `version_mismatch`（不重试、提示升级）。
所以删 broker 方法不是绕过 M1 / M2，而是走它们已经铺好的路：
`CUA_BROKER_IPC_VERSION` 从 `1` 改为 `2`。

### 3.7 存活的 14 个工具（`cua.computer`）

```
list_apps  open_application  list_windows  get_app_state
left_click  scroll  left_click_drag
type  set_value  select_text  key
perform_action
request_access  stop_computer_control
```

`cua.computer` 的角色是暴露**平台特定的底层 computer API**（语义见
`apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md`）。
模型文档提一句、不展开。

住在这里的 ZCode 独有能力：**窗口寻址**（`list_windows` + `app_ref.window_id`，§4.1）、
**pid 精确选择**、**`open_application` 的 `activate` / `confirm_focus_steal` /
`new_instance` / `urls`**（strategy=event 流程的前置，`cua-14-tool-e2e-validity.md`
写明文件面板需要「confirmed open_application followed by a fresh observation」）、
**`select_text` 的 range 形态**（文本匹配的内部实现，§6.3）。

### 3.8 必须保留的三项，附证据

| 能力 | 证据 |
|---|---|
| `strategy: "event"` | `cua-14-tool-e2e-validity.md`：Finder 重命名（M01/M04）、TextEdit 字符样式（M08-M10）、Chromium 键盘导航（C16）**必须** `strategy=event` + 精确 `window_id`，否则 AX 返回成功但文档模型没变（responder chain 的现实）。ZCode 的「不抢用户焦点」是核心卖点，代价就是需要这个逃生门 |
| 窗口寻址 | 同一份文档：M01 / M04 / M08-M10 / C16 都要绑定精确窗口。`observation.ts:1008-1011` 的 tool description 就是教模型回填 `window_id` |
| `modifiers` | cmd+click（新标签页打开）、shift+click（范围选择）无法用组合表达 —— 修饰键必须在按下那一瞬生效 |

`strategy: "a11y"`（强制 AX，无可用动作即 fail-closed）用量极少，
但作为选项键零成本，且是防止静默降级到坐标的唯一手段，保留。

---

## 4. 三处需要特别说明的处置

### 4.1 窗口寻址

ZCode 的工具面跨三平台统一命名（AGENTS.md §2 的核心决定），`getApp` 在三平台
都可用，不按平台拆成两套绑定形态。R1 优先：

- **文档面**：`App` 无窗口成员。`getApp` 绑主 / 键窗口。
- **逃逸口**：`cua.computer.list_windows({app_ref})` + 把 `window_id` 塞回 `app_ref`。
- **未文档化成员**：`cua.getWindow(app: string, windowId: number): Promise<App>`，
  返回绑定到该窗口的 `App`（同 `Target` 接口）。不进 SKILL、不进 `documentation.get()`。

**保留的正确性收益**：现状下传一个失效 `window_id`，Helper 静默降级到最前窗口，
只回 `window_id_fallback: true` 加一句 note（`axReadOnly.ts:1235-1244`），模型极易读漏，
然后在错误窗口上继续操作。`cua.getWindow()` 在 fallback 时**直接抛** `STALE_STATE`。

**已知缺口**：单窗口前台化（`activate_window`）。原生能力存在
（`electronNativeBackendTypes.ts:352` 的 `activateWindow(pid, bundleId, windowId)`，
原子 raise + focus + activate + 身份重校验），但未暴露为 broker method，
只在 window-scoped raw input 内部被调用（`electronInputHandlers.ts:963-970`）。
S5 补一个 `activate_window` broker method 后启用。

### 4.2 结构化 AX 视图：一个需要实测的取舍

R1 要求 `getAXState(): Promise<string>`。这带来**真实成本**：
现状 SKILL 教的是单 cell 完成「观察 → 结构化 find 元素 → 动作」，
字符串返回做不到；索引未知时，一次发现就多一个 round trip。

处置：文档面按 R1 返回 `string`；`app.elements(): Promise<AppElement[]>` 保留结构化视图；
S4 灰度期用 GUI eval 实测两版的 round trip 与通过率，若文本流显著更差，
把 `elements()` 提为文档化成员。**这是全文唯一保留翻盘余地的最小面决定。**

**S4 结论（2026-09-16，翻盘已生效）**：`elements()` 提为**文档化成员**。判据不是 token 或
round trip，而是「树被裁剪时模型没有别的出路」：`targeting/format.ts` 在超过上限时按优先级
选元素并补回祖先链，注记写着 `indices are sparse; N hidden`（真机 736 → 300）。此时被隐藏
元素的索引在树文本里根本不出现，模型只能猜——而 `elements()` 返回的结构化表恒为整表
（"文本可以是 diff，结构必须完整"），是唯一可靠出路。因此它出现在 SKILL 的 Keyboard 段与
`computer-use.md` 的 API 段；实现侧仍保持 `enumerable: false`（R2 约束的是
**可枚举**面，不禁止具名逃逸口）。

配套的安全声明不可省：`elements()` 观察但不展示，所以必须与 `bindApp` / `getScreenshot` 同档
传 `tree_shown_to_model: false`，并清掉 SDK 侧的 `treeSeen`（否则下一次 `getAXState` 会给出
相对一棵未展示树的 diff）。2026-09-16 评审发现这两条当时都漏了，已补齐并有回归测试
（z-code `tests/sdk.node-test.mjs` 的 "every silent observation declares..."）。

把 `state_id` 从模型面拿掉是净收益，与结构化视图无关：索引由 SDK 用该 target 当前的
`stateId` 解析（§5.5），模型不可能再写错 `state_id`，stale 一律 fail-closed，比今天更严。
z-code 2026-08-25 那条「结构化 AppState 是 Worker 唯一事实来源」的加固，
其立论前提（模型要自己拼 `{state_id,index}`）在 v3.1 里已不成立，
降级为**内部**不变量：bridge 收到无结构化 AppState 的响应仍抛
`CUA_STRUCTURED_STATE_UNAVAILABLE`，只是不再要求透给 Worker。

### 4.3 冻结契约的一次显式解冻

`TOOL_NAMES`（30）+ `TIER_TABLE` + `TOOL_REGISTRY` + 跨仓 evaluator manifest
构成一道 4-way drift gate（`manifest.ts` 注释 + `test/manifest.test.ts`），
`docs/cua-14-tool-e2e-validity.md` 是 normative 回归契约，
其中 `protocol.all_30_tools_have_passing_oracles` 要求 30 个名字全部有通过的 oracle。

这道门禁的目的是**防止意外漂移**，不是禁止有意删除。v3.1 的工具删除是一次
**有意解冻**，必须在 commit message 与该 normative 文档里同时写明：
删除清单、每一项的替代路径、以及新的工具计数。
门禁本身保留（14 路仍然四方一致），只是基线数字从 30 改为 14。

---

## 5. 特殊语义与边界

### 5.1 Worker 无状态与跨 cell 状态

ZCode 是 2026-07-28 无状态规格：每次 `js` 一个一次性 Worker，`const app` 活不到下一个 cell。

缓解：`stateId` / `frameId` / diff 基线 / 首用文档标记全部由 **shared host 的 runtime
session** 持有。下一个 cell 里 `await cua.getApp("Notes")` 是**重新绑定，不重新观察**：
能取回该 app 最近 `stateId` 时只展示一行 `reattached: Notes (stateId=…)`，
不再倾倒全树。模型文档不声明「state is persistent across calls」，
而是写 per-cell bootstrap 模板（§7.4），并说明「绑定不跨 cell，但 UI 状态跨 cell」。

### 5.2 `possibly_sent` 防重放

动作公开签名是 `Promise<void>`，失败抛
`ComputerUseError{code, errorName}`（字符串错误码）。
「动作可能已下发」的信息不占签名位：ZCode 的 `action_sent` / `dispatch_status`
是事故驱动的：
一次点击可能已经落地，盲重试会双击。R3 要求只藏不删：

```ts
declare class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode;   // 字符串码，映射自 BrokerErrorCode
  /** 动作是否已下发。false 才可以安全重试同一个非幂等动作。 */
  readonly actionSent: boolean;
  readonly dispatchStatus?: "accepted" | "possibly_sent";
  readonly retry: "reobserve" | "retry" | "never";
  readonly details: Readonly<Record<string, unknown>>;
}
```

| runtime receipt | v3.1 表现 |
|---|---|
| `action_sent:true, dispatch_status:"accepted"` | resolve（void） |
| `action_sent:true, dispatch_status:"possibly_sent"` | **reject**，`actionSent:true`，`retry:"reobserve"` |
| `action_sent:false` | reject，`actionSent:false`，`retry` 按 code |

错误码：`PERMISSION_DENIED` `NOT_AUTHORIZED` `APP_NOT_FOUND` `AMBIGUOUS_APP`
`LAUNCH_FAILED` `INVALID_APP` `ELEMENT_UNAVAILABLE` `STALE_STATE` `NOT_SETTABLE`
`NOT_SELECTABLE` `ACTION_UNAVAILABLE` `FOREGROUND_REQUIRED` `CONTROLLER_BUSY`
`CONTROL_STOPPED` `SCREEN_LOCKED` `HELPER_UNAVAILABLE` `VERSION_MISMATCH` `TIMEOUT`
`STRUCTURED_STATE_UNAVAILABLE` `INTERNAL`。

第二处保留：**frame 精确栅格契约**。
ZCode 的 `frame-contract/` + `official-frame-integrity-v1` 必须保留，
做法是完全内部化：`getScreenshot()` 返回裸 `Uint8Array`，`frameId` 由 SDK 记在 target 上，
坐标动作内部绑定，模型永远看不到也不需要传。

### 5.3 不融合 BUA

- `cua` 上**不存在** `browsers` / `getBrowser` / `createBrowserTab` / `getTab` /
  `listBrowsers` / `listTabs`；`State` **不含** `browsers` 键。
- `Target` 只被 `App` 实现，不与 browser 的 `Tab` 共享类型或实现。
- `agent.browsers` 仍由 Browser Use 独立提供；CUA 不读、不写、不覆盖。
- `agent.documentation.get(name)` 委托链保持现状：CUA 只处理 `"computer-use"`。
- 两个 plugin 各自的 `computer-use-client.mjs` 保持独立，本轮只改 CUA 那份；bridge 共用不变。

### 5.4 明确不做

音频录制、组织级 app 黑名单与逐 app 审批弹窗
（ZCode 用 controller lease + kill switch + 外层 `js` 一次性高风险审批覆盖同类需求；
上游方案已定：内层不新增逐动作审批）。

### 5.5 索引与坐标的解析

```ts
function bindTarget(t: number | Vec2, ctx: TargetSession): ResolvedTarget;
// number → {type:"element", state_id: ctx.stateId!, index: t}
//          stateId 缺失 → throw STALE_STATE（消息给出 `await app.getAXState()`）
// [x,y]  → {type:"coordinate", frame_id: ctx.frameId, x, y}
//          frameId 缺失 → throw STALE_STATE（消息给出 `await app.getScreenshot()`）
```

**不自动补观察**。自动重新观察会把「模型以为点 A、实际点到 B」变成静默错误。
`drag(from, to)` 两端各自绑定。

---

## 6. 内部分层与实现

### 6.1 分层

```
Worker（模型代码）
  globalThis.cua / App                     ← 重写：scripts/computer-use-client.mjs
       │  bridge.call(method, input)        ← 不变（Symbol zcode.node-repl.computer-use-bridge）
       ▼
shared host：CuaRuntimePool                 ← 不变
  └─ ComputerUseRuntime.execute({toolName, arguments, context})
       ├─ withActionPolicy（§6.2）
       ├─ ActionSettler（§6.4）
       ├─ TargetBinder（§5.5）
       └─ TargetSessionStore（§6.5）
       ▼
  14 个存活 handler（observation/pointer/keyboard-runtime/semantic）
       ▼
  BrokerClient → 签名 Helper
```

S0-S4 **Helper 协议零改动**：删除工具层不要求删除 broker 方法。
Helper 侧的死方法清理单独一个 PR（§7.3），避免和 M1 签名 / M2 生命周期纠缠。

### 6.2 `withActionPolicy`

把散在各 handler 的横切关注点收成一个装饰器：

```
killSwitch.ensureRunning()          // 现状 withKillSwitchPreflight
  → setAppDisplaySideband(target)   // 现状 runWithTargetAppDisplayContext（PiP / Win 指示器）
  → controllerLease.ensure()        // → CONTROLLER_BUSY
  → settler.wait(targetKey)
  → handler(args)
  → settler.defer(targetKey)
  → telemetry({durationMs, terminalStatus, toolName, appId})
```

TOCTOU 加固（`app_ref` 的 pid / window_id 后验重写绑定目标）已有，保留。
**不引入逐 app 审批弹窗**。

### 6.3 `selectText` 按内容匹配

模型面签名是 `selectText(elementIndex, text, {prefix, suffix, selectionType})`，
ZCode 现有的是 `select_text({target, text_range:[start,length]})`。

**不需要 Helper 改动**：SDK 读该元素的 value（走现有 `read_element`），
host 侧用 `prefix` / `suffix` 定位唯一匹配，算出 `[start, length]`，
再调现有 `element_select_text`。匹配不唯一 → 抛 `NOT_SELECTABLE` 并给出候选数。
`selectionType` 映射为 `length:0` 的折叠选区。

### 6.4 `ActionSettler`

新增 `ActionSettler`（`defer()` 推高 deadline、`wait()` 等到 deadline），
作用于全平台、按 target 分桶。参数：连续动作之间 `postActionMs` 默认 100ms；
观察前基础等待约 1000ms，有 loading / busy 迹象时递增至最多 5000ms。
后者 S3 用「元素表 hash 两次一致」的本地稳定判定实现（无需 Helper 改动），
S5 再让 Helper 给出 busy 信号。这让 `wait` 工具的删除成为可能（§3.5）。

### 6.5 `TargetSessionStore`

每个绑定 target 在 host 侧持有
`{ appRef, stateId, frameId, diffBaseline, appInstructionsShown, settleDeadline }`。
用途：索引 / 坐标解析基准、diff 基线、`getApp` 重绑定时的 reattach、
app 专属提示只展示一次（`Set` 去重）。
生命周期跟随 runtime session，不跟随 Worker。

### 6.6 `paste`（原生 broker 方法）

**实现方式：原生 Helper 动作，不是 host 侧拼装。**
Helper 内部完成剪贴板保存 → 写入 → 发粘贴键 → 还原。

ZCode 新增一个 broker 方法 `paste`，参数 `{app_ref, target?, text, format}`，
Helper 侧原生实现（macOS NSPasteboard、Windows / Linux 各自剪贴板 API），
保存 / 还原全在 Helper 内部完成。

为什么不用 host 侧组合（`read_clipboard` → `write_clipboard` → 粘贴键 → 还原）：
那需要保留两个 broker 剪贴板原语，而它们在 v3.1 里已经没有别的消费者（§3.6）。
把还原逻辑放进 Helper 还顺带修掉一个竞态：host 侧组合的四步之间，
用户或另一个进程可能改写剪贴板，还原会把用户的新内容覆盖掉。

价值：`typeText` 走逐字符输入，历史上有 macOS unicode 缺陷，多行文本还会触发
自动缩进 / 自动补全；格式化内容与多行文本优先 `paste`。

**排期影响**：`paste` 依赖 Helper 改动，所以落在 S0c（协议瘦身那一个 PR）里，
不在 S1。`md` / `html` 需要多 flavor pasteboard —— S0c 只做 `text`，
传 `md`/`html` 抛 `ACTION_UNAVAILABLE` 并提示降级，S5 补齐。

### 6.7 键位别名规范化

模型对 xdotool / keysym 风格的键名有先验。
在 `findUnsupportedKeyToken` 之前加一层规范化：

| 输入别名 | 规范 token |
|---|---|
| `Return` `Enter` `KP_Enter` | `return` |
| `Control_L` `Control_R` `Control` `Ctrl` | `ctrl` |
| `Alt_L` `Alt_R` `Meta_L` | `alt` |
| `Super_L` `Super_R` `Super` | `cmd`(darwin) / `super`(linux) / `win`(win32) |
| `Shift_L` `Shift_R` | `shift` |
| `Escape` | `esc` |
| `Prior` / `Next` | `pageup` / `pagedown` |
| `period` `comma` `greater` `slash` `minus` `equal` | `.` `,` `>` `/` `-` `=` |
| `KP_0`…`KP_9` | 需 Helper 映射；缺失时抛明确错误而非静默丢弃 |

只做输入侧兼容，不改内部 token 集合，不改跨平台修饰键规则
（macOS `cmd`，Linux / Windows `ctrl` —— 文档继续明说）。

### 6.8 需要新增 / 修改 / 删除的文件

| 文件 | 改动 |
|---|---|
| `z-code .../zcode-cua-plugin/scripts/computer-use-client.mjs` | **重写**：`cua` 全局、`Target`/`App`、自动 emit、错误映射、`cua.computer`(14)、未文档化成员 |
| `z-code .../zcode-cua-plugin/docs/computer-use.md` | 重写为 v3.1 参考（去 browser 半边 + per-cell bootstrap 段） |
| `z-code .../zcode-cua-plugin/skills/computer-use/SKILL.md` | 重写 |
| `zcode-cua/plugin/skills/computer-use/SKILL.md` | 重写（producer 事实源） |
| `zcode-cua/src/tools/zoom.ts` | **删除**（480 行） |
| `zcode-cua/src/broker/server/electronDisplaySelection.ts` | **删除**（S0c；选屏状态层，topology 留在 `lib/display-topology.ts`） |
| `zcode-cua/src/tools/manifest.ts` | `TOOL_NAMES` 30 → 14；`APP_ASSOCIATION_MODE_BY_TOOL` 同步 |
| `zcode-cua/src/tools/tier-table.ts` | `TIER_TABLE` / `READ_ONLY_TOOLS` / `SAFETY_CONTROL_TOOLS` 同步（`left_mouse_up` 退出 SAFETY_CONTROL） |
| `zcode-cua/src/tools/schemas/{observation,pointer,keyboard,runtime}.ts` | 删除 16 个工具的 schema；删 `detail` / `repeat` / `amount` |
| `zcode-cua/src/tools/{observation,pointer,keyboard-runtime}.ts` | 删除对应 handler；`type`/`key` 去掉 repeat 分支 |
| `zcode-cua/src/targeting/format.ts` | compact 无条件带 `actions`、永不带 `bounds`；删 `detail` 分支（§3.3） |
| `zcode-cua/src/targeting/frame-registry.ts` | 不再为 zoom 保留精确栅格字节；错误文案去掉 `zoom` 提示 |
| `zcode-cua/src/targeting/session.ts` | 删 `selectedDisplayId` 状态 |
| `zcode-cua/src/tools/observation.ts` | 放开 delta：三态都映射为完整内部 AppState；去掉两处无条件 `force_full:true`（:644、:1092） |
| `zcode-cua/src/broker/server/axReadOnly.ts` | delta / no_change 响应补齐 `elements` 全表 + 签发新 `state_id` |
| `zcode-cua/src/runtime/action-settler.ts` | 新增（§6.4） |
| `zcode-cua/src/runtime/target-session-store.ts` | 新增（§6.5） |
| `zcode-cua/src/tools/action-policy.ts` | 新增（§6.2），替换 `withKillSwitchPreflight` 调用点 |
| `zcode-cua/src/tools/target-binder.ts` | 新增（§5.5） |
| `zcode-cua/src/broker/types.ts` / `ipcVersion.ts` | **S0c**：`BROKER_METHODS` 63 → 49；IPC 版本 1 → 2（§7.3） |
| Helper 原生层 | **S0c**：删已失去消费者的原生导出；新增原生 `paste`（三平台各一份，§6.6） |
| `zcode-cua/src/tools/keyboard-runtime.ts` | 键位别名（§6.7）；`select_text` 内容匹配（§6.3） |
| `zcode-cua/src/tools/legacyToolMap.ts` | 加两列：`computer`（存活的 14）与 `v3`；被删工具标 `removed` + 替代路径 |
| `zcode-cua/docs/cua-30-tool-e2e-validity.md` | **改名 + 改内容**：30 → 14，`FULL_SURFACE_ORACLE_CHECKS` 集合缩小，写明解冻理由（§4.3） |

---

## 7. 兼容、清扫与测试

### 7.1 兼容通道

1. **`cua.computer.*`**：存活的 14 个方法，schema 与返回 envelope 逐字保留。
2. **`agent.computerUse`**：保留一个版本作为 `cua` 的别名，S5 删除。
3. **`legacyToolMap`**：被删工具标 `removed` + 替代路径，只用于历史 transcript 的
   只读解析与排查，不再执行。

### 7.2 删除清扫清单（S0 的实际工作量）

| 消费者 | 需要做的 |
|---|---|
| `test/manifest.test.ts` 4-way drift gate | 基线 30 → 14，四方仍需一致 |
| `test/tier-table.test.ts` / `annotations.test.ts` | 同步 |
| `docs/cua-14-tool-e2e-validity.md`（normative） | `protocol.all_30_tools_have_passing_oracles` → 14；`FULL_SURFACE_ORACLE_CHECKS` 删除对应条目；写明解冻 |
| `evals/zcode-gui-eval/` | 删除或改写针对被删工具的场景（C18 全表面覆盖用例受影响最大） |
| `scripts/cua_act_verify*.py` + `docs/cua-act-verify-{,windows-,linux-}scenarios.md` | 三平台场景各扫一遍；`hold_key` / `wait` / `select_text` 出现在场景里，需改写为新形态 |
| `scripts/windows-*-live-smoke.mjs` / `verify_linux_*.mjs` | 同步 |
| `test/legacy-tool-map.test.ts` | 加 `removed` 断言 |
| 其余 `docs/` | 引用被删工具的段落 |

### 7.3 broker 协议瘦身（S0c，在本次范围内）

删除清单见 §3.6：15 删 + 1 增（`paste`），可选再删 6 个测试探针。
**独立成一个 PR**，但**不再推到最后** —— `paste` 依赖它，所以它在 SDK 重构之前。

要一起改的：

| 项 | 改动 |
|---|---|
| `src/broker/types.ts` | `BROKER_METHODS` 63 → 49；`READ_ONLY_BROKER_METHODS` 同步剔除已删项 |
| `src/broker/ipcVersion.ts` | `CUA_BROKER_IPC_VERSION` 1 → 2（`ipcVersion.ts` 注释已规定增删方法必须 bump） |
| `src/broker/server/electronInputHandlers.ts` | 删 `move_to` / `mouse_down` / `mouse_up` / `key_down` / `key_up` / `type_text_into_current_focus` / `read_clipboard` / `write_clipboard` handler；新增 `paste` |
| `src/broker/server/electronNativeBackend.ts` | 删 `screenshot` / `list_displays` / `set_display` / `cursor_position` / `screen_size` / `get_skyshot` / `click_element_at_point` handler |
| `src/broker/server/electronDisplaySelection.ts` | 整个删除（topology 留在 `lib/display-topology.ts`） |
| 原生层 | 删对应的 addon 导出（`moveTo` / `mouseDown` / `mouseUp` / `keyDownGlobal` / `keyUpGlobal` / 全屏 `screenshot` / 显示器枚举中仅供选屏的部分）；新增原生 `paste`（NSPasteboard / Win / Linux 各一份） |
| `test/broker/*` | `types.readOnlyMethods.test.ts` 等按新清单更新 |
| 跨版本兼容 | 旧 Helper + 新 host 走 `version_mismatch`（不重试、提示升级），已是 M2 既有路径 |

**回滚粒度**：S0c 单独一个 commit / PR。回滚它会同时回滚 `paste`，
所以 S1 的 `paste` 相关测试要能在 `paste` 缺失时跳过而不是失败。

### 7.4 契约测试改动清单

| 测试 | 现状断言 | 改动 |
|---|---|---|
| `z-code .../zcode-cua-plugin/tests/sdk.node-test.mjs` | `METHOD_NAMES.length === 30` | 改为：`cua.computer` 14 项 + `Target` 12 个成员齐 + `cua` 无任何 browser 成员 |
| 同上 | 动作结果含 `action_sent` / `dispatch_status` | 成功 resolve 为 `undefined`；`possibly_sent` reject 且 `actionSent === true` |
| `zcode-cua/test/skill-keyboard-contract.test.ts` | 钉死 `nodeRepl.write(nextState.text)`、`return_state="none"`、22KB 上限 | 改为钉死「观察方法自动展示」「禁止对观察结果再 write」「per-cell bootstrap」 |
| `zcode-cua/test/observation-tools.test.ts` | delta / no_change → `null` | 反转：三态都返回完整内部 AppState |
| 新增 | —— | surface 精确断言（§7.5）、`target-binder.test.ts`、`action-settler.test.ts`、`key-alias.test.ts`、`paste.test.ts`、`error-mapping.test.ts`、`compact-carries-actions.test.ts` |

### 7.5 surface 门禁

`apps/zcode-cli/packages/zcode-cua-plugin/tests/sdk.node-test.mjs` 对模型可见面做
surface 精确断言：

1. `Target` 的 12 个交互面成员**存在且位置参数同名同序**；
2. 相对核心交互面的**新增项只能是**可选选项键或尾部可选参数，
   或白名单成员（当前白名单：`cua.requestAccess`、`cua.stop`、`cua.computer`）；
   **`Target` 上的附加成员数必须为 0**；
3. `cua` 上不存在 browser 成员，`State` 无 `browsers` 键。

白名单以外的新增会让测试失败，逼迫下一个改 API 的人显式决策。

### 7.6 bootstrap 模板

```js
const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT
  ?? process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href);
await setupComputerUseRuntime({ globals: globalThis });   // 装配 globalThis.cua

const app = await cua.getApp("Notes");
await app.click(42);
await app.getAXState();
```

`setupComputerUseRuntime` 幂等，每个 cell 都要跑。`cua.getState()` 只在需要 app 清单时调；
参考文档按需取（`agent.documentation.get("computer-use")`），不做首用推送。

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0a** | **独立小 PR**：compact 无条件带 `actions`、永不带 `bounds`，删 `detail`（§3.3） | `compact-carries-actions.test.ts`；`perform_action` 不再需要 `detail:"full"` |
| **S0b** | **工具面瘦身 30 → 14**（§3.2 / §3.4 / §3.5）+ 全量清扫（§7.2）+ 解冻文档（§4.3） | 4-way drift gate 基线 14 且四方一致；evals / act-verify / smoke 全绿；`zoom.ts` 删除后 `pnpm typecheck` 通过 |
| **S0c** | **broker 协议瘦身 63 → 49 + 原生 `paste`**（§3.6 / §7.3），含原生层与 `electronDisplaySelection.ts` 删除、IPC 版本 1 → 2 | 旧 Helper + 新 host 走 `version_mismatch`；三平台 Helper 构建通过；`paste`(text) 有真实粘贴 oracle |
| **S1** | `cua` 全局 + `Target`/`App` + `TargetBinder` + `TargetSessionStore` + 错误映射 + `cua.computer` | `sdk.node-test.mjs` surface 断言绿（`Target` 附加成员 0）；`error-mapping.test.ts` 覆盖全部 code |
| **S2** | 自动 emit + 首用文档披露 + delta 放开（Helper 补 `elements` 与新 `state_id`） | 同任务观察 token 相比 S1 降 ≥60%；`no_change` 不再触发 force_full；无重复输出 |
| **S3** | `ActionSettler` + `withActionPolicy` | SKILL 里「模型自己等待」的措辞全部移除；act-verify 通过率不下降 |
| **S4** | `selectText` 内容匹配、键位别名、`getWindow`（保持未文档化）/ `elements`（已提为文档化）；§4.2 取舍实测 | 4 组新单测 + 三平台 act-verify 各一条新场景；产出 `elements()` 是否提为文档化成员的结论 |
| **S5** | SKILL / `computer-use.md` / legacyToolMap / provenance 同步；灰度；删 `agent.computerUse` 别名；`activate_window`；`paste` 的 `md`/`html` | 契约测试全绿；`pnpm typecheck` `pnpm lint`；GUI eval 不回归 |
| **S6**（可选） | 删 6 个 `pip_live_probe_*` 测试探针（63 → 43）、busy 信号、`numpad` keysym | —— |

S0a 可以立即开工，不依赖任何模型面决定。S0b 先做能让后续改动面小一半。
S0c 必须在 S1 之前，因为 `paste` 依赖它。
灰度开关 `ZCODE_CUA_SDK_SURFACE=v1|v3`（默认 v1，观察期后翻 v3）。

---

## 9. 风险

| 风险 | 对策 |
|---|---|
| 删掉 16 个工具 + 15 个 broker 方法后发现某个真的需要 | **恢复成本已经不小**：要加回 schema + handler + broker 方法 + 三平台原生实现 + 再 bump 一次 IPC 版本。所以每一项的删除理由与替代路径都写在案（§3.2-3.6、附录 B）；S0b 与 S0c 各自单独成 PR，便于整体回滚。评审确认接受这个成本 |
| 失去「按住 → 观察 → 释放」与剪贴板读取 | 评审已确认接受（§3.5）。不保留 broker 原语「以备将来」 |
| 失去全屏观察 | `listApps()` + `getApp()` 替代；macOS 系统 UI 都是有 AX 的进程 |
| 删 zoom 后小字不可读 | 需在 S0b 量化 per-app 截图的实际缩放率。若缩放确实严重，正解是调 per-app 截图预算，而不是恢复 zoom |
| S0c 回滚会一起回滚 `paste` | S1 起的 `paste` 测试在 `paste` 方法缺失时跳过而非失败（§7.3） |
| 原生 `paste` 三平台各写一份，工作量与回归面比 host 侧组合大 | 换来的是少两个 broker 原语 + 修掉还原竞态（§6.6）；S0c 只做 `text`，`md`/`html` 推到 S5 |
| `getAXState()` 返回 string 使「发现元素」多一个 round trip | `app.elements()` 兜底；S4 已结论为提升为文档化成员（§4.2） |
| `possibly_sent` 从文本提示变 throw，Electron/Chromium 可能高频抛错 | S1 先只**统计**（照旧 resolve + 打点频率），确认基线后再翻；保留 `ZCODE_CUA_POSSIBLY_SENT=throw\|warn` |
| 放开 delta 后模型复用旧索引 | delta 也签发新 `stateId`；索引由 SDK 用当前 `stateId` 解析；stale 一律 fail-closed（比今天更严） |
| 自动 emit 与宿主 structured sink 双写导致重复输出 | 沿用现有 `hostProjectionResult` / `imageAuthorityResult` 边界；`format-model-facing-budget.test.ts` 扩一条重复检测 |
| 绑定不跨 cell 被误解为「状态丢了」 | 文档明写「每 cell 重新 `getApp`，UI 状态与 stateId 由 host 保留」；reattach 只输出一行 |
| 解冻 30 工具契约削弱防漂移能力 | 门禁保留，只改基线；解冻理由与删除清单写进 normative 文档与 commit message |
| Windows / Linux 上 `getApp` 语义与 macOS 不一致 | ZCode **不**在非 macOS 抛错（三平台统一是既有优势）；能力缺失走类型化错误：Linux 无 AX 元素 → `ELEMENT_UNAVAILABLE`；Linux/Windows 键盘无 pid 定向 → `FOREGROUND_REQUIRED`。`cua.computer.target` 暴露平台供模型分支 |

---

## 附录 A：v3.1 用例

```js
// ── 配方 1：绑定 → 动作 → 观察
const app = await cua.getApp("Notes");       // 展示初始全树
await app.click(42);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();                       // 自动展示 diff

// ── 配方 2：坐标兜底（canvas / Electron / 无 AX 元素）
const app2 = await cua.getApp("Figma");
const png = await app2.getScreenshot();       // per-app 截图，建立内部 frameId 并展示
await app2.click([640, 240]);                 // 像素取自这张栅格
await app2.getAXStateAndScreenshot();

// ── 配方 3：ZCode 附加项（只在选项袋里）
await app.click(42, { mouseButton: "right", modifiers: "cmd", strategy: "a11y" });
await app.pressKey("Return", { holdSeconds: 0.5 });
for (let i = 0; i < 3; i++) await app.pressKey("Down");   // 取代已删除的 repeat
await app.paste("多行\n内容");

// ── 配方 4：逃逸口（多窗口）
const wins = await cua.computer.list_windows({ app_ref: { name: "Preview" } });
const w = await cua.getWindow("Preview", wins[1].window_id);   // 未文档化成员
await w.click(7);
await w.getAXState();

// ── 配方 5：错误处理
try {
  await app.performSecondaryAction(7, "Show Menu");
} catch (e) {
  if (e.code === "ACTION_UNAVAILABLE") {
    await app.getAXState({ disableDiffing: true });   // compact 已带 actions，看清合法取值
  } else if (e.code === "CONTROLLER_BUSY") {
    nodeRepl.write(`another ZCode Computer Use session owns control: ${e.details.owner}`);
  } else if (e.actionSent) {
    await app.getAXState();                            // 可能已落地，先看状态再决定
  } else throw e;
}
```

---

## 附录 B：30 个工具的处置

| 工具 | 处置 | 替代路径 |
|---|---|---|
| `list_apps` | **留** | `cua.listApps()` |
| `open_application` | **留**（逃逸口） | `getApp` 已透明启动；`activate` 走逃逸口 |
| `list_windows` | **留**（逃逸口） | `cua.getWindow()`（未文档化） |
| `get_app_state` | **留** | `app.getAXState()` / `getAXStateAndScreenshot()` / `getScreenshot()` |
| `left_click` | **留** | `app.click(t, opts)` |
| `scroll` | **留** | `app.scroll(t, dir, pages)` |
| `left_click_drag` | **留** | `app.drag(from, to)` |
| `type` | **留** | `app.typeText(text)` |
| `set_value` | **留** | `app.setValue(i, v)` |
| `select_text` | **留**（逃逸口 = range 形态） | `app.selectText(i, text, opts)` |
| `key` | **留**（去 `repeat`） | `app.pressKey(key, opts)` |
| `perform_action` | **留** | `app.performSecondaryAction(i, a)` |
| `request_access` | **留** | `cua.requestAccess()` |
| `stop_computer_control` | **留** | `cua.stop()` |
| `screenshot`（全屏） | **删** | `app.getScreenshot()`（per-app） |
| `zoom` | **删** | 无（调 per-app 截图预算） |
| `list_displays` | **删** | 无（per-app 捕获按窗口所在屏工作） |
| `switch_display` | **删** | 同上 |
| `cursor_position` | **删** | 无（纯诊断） |
| `wait` | **删** | SDK 内建 settler |
| `double_click` | **删** | `click(t, {clickCount: 2})` |
| `triple_click` | **删** | `click(t, {clickCount: 3})` |
| `right_click` | **删** | `click(t, {mouseButton: "right"})` |
| `middle_click` | **删** | `click(t, {mouseButton: "middle"})` |
| `hold_key` | **删** | `pressKey(key, {holdSeconds})` |
| `mouse_move` | **删** | 无；broker `move_to` 一并删 |
| `left_mouse_down` | **删** | `drag(from, to)`；broker `mouse_down` 一并删 |
| `left_mouse_up` | **删** | 同上；broker `mouse_up` 一并删 |
| `read_clipboard` | **删** | 无；broker 方法一并删 |
| `write_clipboard` | **删** | `app.paste(text)`（原生 broker `paste`）；旧 broker 方法一并删 |

存活 14，删除 16。删除项中 9 项有等价替代，5 项（全屏像素簇）能力由 per-app 路径覆盖，
2 项（`read_clipboard`、按住类）是评审确认接受的能力收缩。

broker 协议同步 63 → 49（删 15 + 新增原生 `paste`），可选再删 6 个测试探针到 43。见 §3.6。
