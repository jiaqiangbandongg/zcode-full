/** 既有布局入口的类型；模型、权限及会话状态不属于此契约。 */
export interface ComposerToolbarLayoutContract {
  fit: typeof import("@/prompt-editor/useComposerToolbarFit.js").fitComposerToolbar;
}

export type UseComposerToolbarFit =
  typeof import("@/prompt-editor/useComposerToolbarFit.js").useComposerToolbarFit;
