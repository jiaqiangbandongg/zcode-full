import type { CollaborationMode } from "@zcode/contracts";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { TuiSetMode } from "./types.js";

export const TUI_SWITCHABLE_MODES = ["plan", "build", "guarded", "yolo"] as const;

export type TuiSwitchableMode = (typeof TUI_SWITCHABLE_MODES)[number];

function nextTuiSwitchableMode(currentMode: CollaborationMode | string): TuiSwitchableMode {
  const currentIndex = TUI_SWITCHABLE_MODES.findIndex((mode) => mode === currentMode);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % TUI_SWITCHABLE_MODES.length;
  return TUI_SWITCHABLE_MODES[nextIndex];
}

function formatModeSwitchStatus(mode: CollaborationMode | string): string {
  return `Mode switched to ${formatTuiModeLabel(mode)}.`;
}

function formatModeSwitchFailedStatus(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Mode switch failed: ${message}`;
}

export function useTuiModeSwitcher({
  mode,
  setMode,
  setModeHandler,
  setStatus,
}: {
  mode: CollaborationMode;
  setMode: Dispatch<SetStateAction<CollaborationMode>>;
  setModeHandler?: TuiSetMode;
  setStatus: Dispatch<SetStateAction<string>>;
}): () => void {
  return useCallback(() => {
    if (!setModeHandler) {
      setStatus("Mode switching is not available in this client.");
      return;
    }

    const previousMode = mode;
    const nextMode = nextTuiSwitchableMode(mode);
    // Keyboard handlers fire-and-forget this promise, so reflect the local mode
    // immediately and roll back if the session mutation fails.
    setMode(nextMode);
    void Promise.resolve(setModeHandler(nextMode)).then(
      (result) => {
        setMode(result.mode);
        setStatus(result.response ?? formatModeSwitchStatus(result.mode));
      },
      (error: unknown) => {
        setMode(previousMode);
        setStatus(formatModeSwitchFailedStatus(error));
      },
    );
  }, [mode, setMode, setModeHandler, setStatus]);
}

function formatTuiModeLabel(mode: CollaborationMode | string): string {
  if (mode.length === 0) return mode;
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}
