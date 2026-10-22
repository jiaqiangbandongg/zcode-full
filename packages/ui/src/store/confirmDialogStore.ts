import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** E2E/可访问性使用的稳定业务语义，不依赖本地化标题文本。 */
  intent?: string;
  /** 特定业务弹框的稳定视觉规范；默认确认框不受影响。 */
  presentation?: "automation-confirmation" | "source-server-boundary";
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  showCloseButton?: boolean;
  /** 需要用户显式确认的告知弹窗：隐藏取消，并忽略遮罩/Escape 关闭。 */
  requiredAcknowledgement?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
}

export type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest) => Promise<boolean>;
  requestChoice: (payload: ConfirmDialogRequest) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload) => (await get().requestChoice(payload)) === "confirm",
  requestChoice: (payload) => {
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      set({
        pendingRequest: {
          ...payload,
          resolve,
        },
      });
    });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
