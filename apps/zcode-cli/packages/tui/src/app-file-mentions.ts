import type { KeyEvent } from "@mbears/opentui-core";
import React from "react";
import { clampIndex } from "./app-input.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import type { DraftAttachment, SlashSelectionState } from "./app-model.js";
import type { TuiListWorkspacePathSuggestions, TuiWorkspacePathSuggestion } from "./types.js";

export const FILE_MENTION_VISIBLE_COUNT = 8;
const FILE_MENTION_QUERY_LIMIT = 50;
const FILE_MENTION_SIGIL = "@";
const FILE_MENTION_ATTACHED_STATUS_PREFIX = "Attached";
const FILE_MENTION_DISMISSED_STATUS = "File suggestions dismissed.";
const FILE_MENTION_EMPTY_STATUS = "No matching workspace path.";

export type ActiveFileMention = {
  endOffset: number;
  token: string;
  triggerIndex: number;
};

export type FileMentionState = ActiveFileMention & {
  error?: string;
  items: readonly TuiWorkspacePathSuggestion[];
  loading: boolean;
  selectedIndex: number;
  truncated: boolean;
};

type FileMentionController = {
  handleKey: (key: KeyEvent) => boolean;
  state: FileMentionState | undefined;
};

export function useFileMentionController(options: {
  busy: boolean;
  draft: string;
  editorRef: React.MutableRefObject<PromptInputEditor | null>;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  nextAttachmentIdRef: React.MutableRefObject<number>;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
}): FileMentionController {
  const [state, setState] = React.useState<FileMentionState | undefined>();
  const dismissedKeyRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const provider = options.listWorkspacePathSuggestions;
    const cursorOffset = promptEditorCursorOffset(options.editorRef.current, options.draft.length);
    const active = resolveActiveFileMention(options.draft, cursorOffset);
    if (options.busy || !provider || !active) {
      setState(undefined);
      return undefined;
    }

    const key = fileMentionKey(active);
    if (dismissedKeyRef.current === key) {
      setState(undefined);
      return undefined;
    }

    const abortController = new AbortController();
    setState((current) =>
      current && fileMentionKey(current) === key
        ? { ...current, ...active, error: undefined, loading: true }
        : {
            ...active,
            items: [],
            loading: true,
            selectedIndex: 0,
            truncated: false,
          },
    );

    void provider({
      abortSignal: abortController.signal,
      limit: FILE_MENTION_QUERY_LIMIT,
      token: active.token,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        setState((current) =>
          current && fileMentionKey(current) === key
            ? {
                ...current,
                error: undefined,
                items: result.items,
                loading: false,
                selectedIndex: clampIndex(current.selectedIndex, result.items.length),
                truncated: result.truncated,
              }
            : current,
        );
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setState((current) =>
          current && fileMentionKey(current) === key
            ? {
                ...current,
                error: error instanceof Error ? error.message : String(error),
                items: [],
                loading: false,
                selectedIndex: 0,
                truncated: false,
              }
            : current,
        );
      });

    return () => abortController.abort();
  }, [options.busy, options.draft, options.editorRef, options.listWorkspacePathSuggestions]);

  const handleKey = React.useCallback(
    (key: KeyEvent): boolean => {
      if (!state) return false;
      if (key.name === "escape") {
        dismissedKeyRef.current = fileMentionKey(state);
        setState(undefined);
        options.setStatus(FILE_MENTION_DISMISSED_STATUS);
        return true;
      }
      if (key.name === "up" || key.name === "down") {
        const delta = key.name === "up" ? -1 : 1;
        setState((current) =>
          current
            ? {
                ...current,
                selectedIndex: clampIndex(current.selectedIndex + delta, current.items.length),
              }
            : current,
        );
        return true;
      }
      if (key.name === "tab" || key.name === "return") {
        completeFileMention(state, options);
        return true;
      }
      return false;
    },
    [options, state],
  );

  return { handleKey, state };
}

export function promptEditorCursorOffset(
  editor: Pick<PromptInputEditor, "cursorOffset"> | null,
  fallbackOffset: number,
): number {
  if (!editor) return fallbackOffset;
  try {
    return editor.cursorOffset;
  } catch {
    // A stale OpenTUI EditorView can throw after React remounts the prompt; the
    // controlled draft length keeps file mention detection recoverable.
    return fallbackOffset;
  }
}

export function resolveActiveFileMention(
  text: string,
  cursorOffset = text.length,
): ActiveFileMention | undefined {
  const normalizedCursorOffset = clampOffset(cursorOffset, text.length);
  const beforeCursor = text.slice(0, normalizedCursorOffset);
  const triggerIndex = beforeCursor.lastIndexOf(FILE_MENTION_SIGIL);
  if (triggerIndex < 0) return undefined;

  const beforeTrigger = triggerIndex === 0 ? undefined : text[triggerIndex - 1];
  if (beforeTrigger !== undefined && !/\s/u.test(beforeTrigger)) return undefined;

  const token = beforeCursor.slice(triggerIndex + FILE_MENTION_SIGIL.length);
  if (/\s/u.test(token)) return undefined;
  return {
    endOffset: normalizedCursorOffset,
    token,
    triggerIndex,
  };
}

export function visibleFileMentionWindow(
  items: readonly TuiWorkspacePathSuggestion[],
  selectedIndex: number,
  maxVisible: number,
): {
  items: readonly TuiWorkspacePathSuggestion[];
  selectedIndex: number;
  startIndex: number;
} {
  if (items.length === 0 || maxVisible <= 0) {
    return {
      items: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, items.length);
  const visibleCount = Math.min(maxVisible, items.length);
  const maxStartIndex = items.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    items: items.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

function completeFileMention(
  state: FileMentionState,
  options: {
    draft: string;
    editorRef: React.MutableRefObject<PromptInputEditor | null>;
    nextAttachmentIdRef: React.MutableRefObject<number>;
    setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
    setDraftValue: (value: string) => void;
    setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
    setStatus: React.Dispatch<React.SetStateAction<string>>;
  },
): void {
  const item = state.items[clampIndex(state.selectedIndex, state.items.length)];
  if (!item) {
    options.setStatus(FILE_MENTION_EMPTY_STATUS);
    return;
  }

  options.setSlashSelection(undefined);
  if (item.kind === "directory") {
    replaceMentionText(
      options.editorRef.current,
      options.draft,
      state,
      `${FILE_MENTION_SIGIL}${item.path}`,
      options.setDraftValue,
    );
    return;
  }

  const placeholder = `${FILE_MENTION_SIGIL}${item.path}`;
  options.setDraftAttachments((current) =>
    current.some(
      (attachment) => attachment.type === "file" && attachment.placeholder === placeholder,
    )
      ? current
      : [
          ...current,
          {
            id: options.nextAttachmentIdRef.current++,
            path: item.path,
            placeholder,
            type: "file" as const,
          },
        ],
  );
  replaceMentionText(
    options.editorRef.current,
    options.draft,
    state,
    `${placeholder} `,
    options.setDraftValue,
  );
  options.setStatus(`${FILE_MENTION_ATTACHED_STATUS_PREFIX} ${placeholder}.`);
}

function replaceMentionText(
  editor: PromptInputEditor | null,
  draft: string,
  mention: ActiveFileMention,
  replacement: string,
  setDraftValue: (value: string) => void,
): void {
  if (!editor) {
    setDraftValue(
      `${draft.slice(0, mention.triggerIndex)}${replacement}${draft.slice(mention.endOffset)}`,
    );
    return;
  }

  try {
    const endOffset = editor.cursorOffset;
    editor.cursorOffset = mention.triggerIndex;
    const startCursor = editor.logicalCursor;
    editor.cursorOffset = endOffset;
    const endCursor = editor.logicalCursor;
    editor.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col);
    editor.insertText(replacement);
    setDraftValue(editor.plainText);
    editor.focus();
  } catch {
    setDraftValue(
      `${draft.slice(0, mention.triggerIndex)}${replacement}${draft.slice(mention.endOffset)}`,
    );
  }
}

function fileMentionKey(mention: ActiveFileMention): string {
  return `${mention.triggerIndex}:${mention.endOffset}:${mention.token}`;
}

function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return length;
  return Math.max(0, Math.min(Math.trunc(offset), length));
}
