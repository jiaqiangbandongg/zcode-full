import { createContext } from "react";

/** 菜单持有切换意图；输入框只投影当前草稿是否允许提交，不保存第二份草稿。 */
export const ComposerSubmissionPendingContext = createContext<((pending: boolean) => void) | null>(
  null,
);
