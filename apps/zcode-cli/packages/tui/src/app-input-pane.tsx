import type { TextareaRenderable } from "@mbears/opentui-core";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { InputComposerStatus } from "./app-input-status.js";
import { wordWrappedLineCount } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export const INPUT_DEFAULT_EDITOR_ROWS = 2;
export const INPUT_MIN_EDITOR_ROWS = INPUT_DEFAULT_EDITOR_ROWS;
export const INPUT_MAX_EDITOR_ROWS = 6;
const INPUT_FRAME_CHROME_ROWS = 3;
export const INPUT_PANE_STATUS_ROWS = 1;
const INPUT_CHROME_ROWS = INPUT_FRAME_CHROME_ROWS + INPUT_PANE_STATUS_ROWS;
const INPUT_CONTENT_FALLBACK_WIDTH = 80;
const INPUT_MIN_CONTENT_WIDTH = 8;
const INPUT_PANE_HORIZONTAL_CHROME_WIDTH = 4;

export const INPUT_PANE_MIN_HEIGHT = INPUT_MIN_EDITOR_ROWS + INPUT_CHROME_ROWS;
export const INPUT_PANE_MAX_HEIGHT = INPUT_MAX_EDITOR_ROWS + INPUT_CHROME_ROWS;
export const INPUT_PANE_BORDER = true;
export const INPUT_PANE_BORDER_STYLE = "rounded";
export const INPUT_PANE_STATUS_SPACER_STYLE = {
  flexGrow: 1,
  minHeight: 0,
} as const;

export const PROMPT_TEXTAREA_KEY_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
] as const;

export type PromptInputEditor = Pick<
  TextareaRenderable,
  | "cursorOffset"
  | "deleteRange"
  | "focus"
  | "focused"
  | "gotoBufferEnd"
  | "insertText"
  | "logicalCursor"
  | "plainText"
  | "setText"
>;

type DraftTextarea = Pick<PromptInputEditor, "gotoBufferEnd" | "plainText" | "setText">;

export function InputPane({
  busy,
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  focused,
  mode,
  model,
  onInput,
  onSubmit,
  editorRef,
  resetCursorToEndVersion,
  thoughtLevel,
  value,
}: {
  busy: boolean;
  contentWidth?: number;
  copy?: TuiCopy;
  editorRef?: React.MutableRefObject<PromptInputEditor | null>;
  focused: boolean;
  mode?: string;
  model: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
  resetCursorToEndVersion: number;
  thoughtLevel: string;
  value: string;
}): React.ReactElement {
  const textareaRef = React.useRef<TextareaRenderable | null>(null);
  const appliedCursorToEndVersionRef = React.useRef(0);
  const syncingValueRef = React.useRef(false);
  const editorRows = inputPaneEditorRows(value, contentWidth);

  const setTextareaRef = React.useCallback(
    (textarea: TextareaRenderable | null) => {
      textareaRef.current = textarea;
      if (editorRef) {
        // OpenTUI destroys the previous EditorView during keyed remounts; keep
        // the shared prompt editor ref aligned with the live textarea instance.
        editorRef.current = textarea;
      }
    },
    [editorRef],
  );

  React.useLayoutEffect(() => {
    if (!editorRef) return undefined;
    editorRef.current = textareaRef.current;
    return () => {
      editorRef.current = null;
    };
  }, [editorRef]);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    syncingValueRef.current = true;
    try {
      syncTextareaValue(textarea, value);
    } finally {
      syncingValueRef.current = false;
    }
  }, [value]);

  React.useLayoutEffect(() => {
    if (resetCursorToEndVersion <= 0) return;
    if (appliedCursorToEndVersionRef.current === resetCursorToEndVersion) return;
    appliedCursorToEndVersionRef.current = resetCursorToEndVersion;
    const textarea = textareaRef.current;
    if (textarea) moveInputCursorToEnd(textarea);
  }, [resetCursorToEndVersion, value]);

  const handleContentChange = React.useCallback(() => {
    if (syncingValueRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    // OpenTUI can echo a controlled setText as content-change after
    // sync finishes; treating that as user input exits history navigation.
    if (!shouldEmitTextareaInput(value, textarea.plainText)) return;
    onInput(textarea.plainText);
  }, [onInput, value]);

  const handleSubmit = React.useCallback(() => {
    onSubmit(textareaRef.current?.plainText ?? value);
  }, [onSubmit, value]);
  const title = inputPaneTitle(copy, mode);

  return h(
    "box",
    {
      title,
      style: inputPaneContainerStyle(focused, editorRows),
    },
    h("textarea", {
      focused,
      initialValue: value,
      keyBindings: PROMPT_TEXTAREA_KEY_BINDINGS,
      onContentChange: handleContentChange,
      onSubmit: handleSubmit,
      placeholder: inputPanePlaceholder(copy, busy),
      ref: setTextareaRef,
      style: inputPaneTextareaStyle(editorRows),
    }),
    h("box", { style: INPUT_PANE_STATUS_SPACER_STYLE }),
    h(InputComposerStatus, {
      contentWidth: inputPaneStatusContentWidth(contentWidth),
      model,
      thoughtLevel,
    }),
  );
}

export function inputPaneTitle(copy: TuiCopy, mode?: string): string {
  const title = mode ? formatInputModeLabel(mode) : copy.input.title;
  return ` ${title} `;
}

export function inputPanePlaceholder(copy: TuiCopy, busy: boolean): string {
  return busy ? copy.input.busyPlaceholder : copy.input.placeholder;
}

export function inputPaneEditorRows(value: string, contentWidth?: number): number {
  const contentRows = wordWrappedLineCount(value, normalizeInputContentWidth(contentWidth));
  return normalizeEditorRows(contentRows);
}

export function inputPaneHeight(editorRows: number): number {
  return normalizeEditorRows(editorRows) + INPUT_CHROME_ROWS;
}

export function inputPaneContainerStyle(
  focused: boolean,
  editorRows = INPUT_MIN_EDITOR_ROWS,
): Record<string, unknown> {
  const height = inputPaneHeight(editorRows);
  return {
    backgroundColor: palette.panel,
    border: INPUT_PANE_BORDER,
    borderColor: focused ? palette.accent : palette.border,
    borderStyle: INPUT_PANE_BORDER_STYLE,
    flexDirection: "column",
    height,
    maxHeight: INPUT_PANE_MAX_HEIGHT,
    minHeight: INPUT_PANE_MIN_HEIGHT,
    paddingLeft: 1,
    paddingRight: 1,
  };
}

export function inputPaneTextareaStyle(editorRows: number): Record<string, unknown> {
  return {
    focusedBackgroundColor: palette.panel,
    focusedTextColor: palette.text,
    height: normalizeEditorRows(editorRows),
    maxHeight: INPUT_MAX_EDITOR_ROWS,
    minHeight: INPUT_MIN_EDITOR_ROWS,
    placeholderColor: palette.muted,
    textColor: palette.text,
    width: "100%",
    wrapMode: "word",
  };
}

export function syncTextareaValue(textarea: DraftTextarea, value: string): boolean {
  if (textarea.plainText === value) return false;
  textarea.setText(value);
  moveInputCursorToEnd(textarea);
  return true;
}

export function shouldEmitTextareaInput(controlledValue: string, editorValue: string): boolean {
  return editorValue !== controlledValue;
}

export function moveInputCursorToEnd(input: Pick<TextareaRenderable, "gotoBufferEnd">): void {
  // OpenTUI controlled value updates can leave the previous cursor viewport in
  // place after history recall; gotoBufferEnd refreshes both cursor and scroll.
  input.gotoBufferEnd();
}

function normalizeInputContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return INPUT_CONTENT_FALLBACK_WIDTH;
  }
  return Math.max(INPUT_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

function inputPaneStatusContentWidth(contentWidth?: number): number | undefined {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) return undefined;
  return Math.max(
    INPUT_MIN_CONTENT_WIDTH,
    Math.floor(contentWidth) - INPUT_PANE_HORIZONTAL_CHROME_WIDTH,
  );
}

function normalizeEditorRows(rows: number): number {
  return Math.min(INPUT_MAX_EDITOR_ROWS, Math.max(INPUT_MIN_EDITOR_ROWS, Math.floor(rows)));
}

function formatInputModeLabel(mode: string): string {
  if (mode.length === 0) return mode;
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}
