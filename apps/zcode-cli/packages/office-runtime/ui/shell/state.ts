import { useEffect, useState } from "react";
import {
  type DocKind,
  type DocumentInfo,
  type DocxBlockKey,
  type Selection,
} from "#office/contract.ts";
import { cut } from "#office/domain/text.ts";
import { getHost } from "#ui/host.ts";
import type { Strings } from "#ui/i18n.ts";
import { CallError } from "#ui/rpc.ts";
import type { RevealedTarget, SelectionDetail } from "#ui/viewers/types.ts";

// 面板外壳（main.tsx）共用的状态类型与持久化、错误描述等辅助函数，从 main.tsx 拆出以控制单文件规模。

export interface LoadedDoc {
  info: DocumentInfo;
  bytes: ArrayBuffer;
  blocks?: DocxBlockKey[];
  /** Increments on every (re)load so the viewer remounts. */
  key: number;
}

export interface Reference {
  anchor: string;
  text: string;
}

export interface Picked {
  selection: Selection;
  detail: SelectionDetail;
}

export interface AgentPointer {
  note: string | null;
  targets: RevealedTarget[];
  index: number;
  /** The callout (note and stepping); the marks stay after it is dismissed. */
  visible: boolean;
}

export interface Failure {
  path: string | null;
  title: string;
  detail: string;
}

export const clip = (text: string, length: number) =>
  text.length > length ? `${cut(text, 0, length - 1)}…` : text;

export function readRecent(): { path: string; kind: DocKind }[] {
  return getHost().readWindow().recent ?? [];
}
export function writeRecent(items: { path: string; kind: DocKind }[]) {
  getHost().saveWindow({ recent: items });
}

export function describeFailure(t: Strings, error: unknown, path: string | null): Failure {
  const code =
    error instanceof CallError
      ? error.code
      : (error as Error)?.name === "PasswordException"
        ? "password"
        : undefined;
  const [title, detail] = (code && t.errors[code]) || t.errors.generic;
  const message = error instanceof Error ? error.message : String(error);
  return { path, title, detail: detail || message };
}

export function useHostContext() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick((tick) => tick + 1);
    window.addEventListener("office:hostchange", update);
    return () => window.removeEventListener("office:hostchange", update);
  }, []);
  return getHost().context;
}
