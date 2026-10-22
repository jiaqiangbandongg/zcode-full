// side-pane-full-view 模块契约（spec：docs/ui/side-pane-full-view.md）。
// 只放类型；运行时实现经 index.ts 暴露。

export type SidePaneFullViewSurface = "conversation" | "side-pane";
export type SidePaneFullViewFloating = "collapsed" | "expanded" | "minimized";

export interface SidePaneFullViewState {
  readonly surface: SidePaneFullViewSurface;
  readonly floating: SidePaneFullViewFloating;
}

export interface SidePaneFullViewController {
  /** 生效中的完整视图；面板关闭、平台不支持或当前 owner 没有记录时为 null。 */
  readonly fullView: SidePaneFullViewState | null;
  enter(): void;
  exit(): void;
  toggle(): void;
  setSurface(surface: SidePaneFullViewSurface): void;
  setFloating(floating: SidePaneFullViewFloating): void;
}

export type FloatingAnchor =
  | "top-left"
  | "top-right"
  | "left-center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type SidePaneFullViewHostMode = "normal" | "conversation" | "floating";

export type ConversationPanePresentation = "docked" | "floating";

export interface FloatingAnswer {
  readonly rowId: number;
  readonly text: string;
}

export interface ConversationPaneFloatingStatus {
  readonly running: boolean;
  readonly blockingInteractionId: string | null;
  /** 当前对话 owner（正式任务 taskId，草稿 `__draft__`）；回答气泡按它分开记录。 */
  readonly ownerKey: string;
  /**
   * 时间线最后一个回合的运行状态与最终回答，二者取自同一个 render unit；
   * 尚无时间线上报时为 null。
   */
  readonly latestTurn: {
    readonly turnKey: string | null;
    readonly running: boolean;
    readonly answer: FloatingAnswer | null;
  } | null;
}

/**
 * 每个 owner 的回答气泡。seenTurnKey 是已经算作「看过」的最后一个回合：
 * undefined 表示还没建立基线（第一次看到该 owner，或刚回到浮窗形态）；null 表示基线时正在运行、
 * 还没有看过的已结束回合。之后出现 turnKey 不同、已结束且有最终回答的回合就弹出。
 * 不依赖观察到「运行中」：很快结束的回合可能在一次渲染里就从未开始变成已结束。
 */
export interface FloatingAnswerBubbleState {
  readonly seenTurnKey: string | null | undefined;
  readonly answer: FloatingAnswer | null;
}

export interface ConversationPanePresentationValue {
  readonly presentation: ConversationPanePresentation;
  /** 焦点 pane 上报运行状态与阻塞交互，供浮窗操作栏和最小化按钮展示。 */
  readonly reportFloatingStatus: (status: ConversationPaneFloatingStatus) => void;
  /** 焦点 pane 上报底部输入区实测高度，浮窗收起态按它裁剪。 */
  readonly reportComposerDockHeight: (heightPx: number) => void;
}
