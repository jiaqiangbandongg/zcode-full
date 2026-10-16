# @ Mention Panel Virtual Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard limit (`FILE_MENTION_RESULT_LIMIT = 100`) in the @ mention panel with virtual scrolling, so users can browse and search all workspace files without performance degradation.

**Architecture:** Use `@tanstack/react-virtual` to virtualize the `MentionPanel` list rendering — only visible rows get mounted to the DOM. Remove the hard cap in `fileMentionProvider` and let the virtualizer handle arbitrarily large filtered result sets. The fuzzy search pipeline (`mentionSearch.ts`) stays unchanged; only the rendering layer and the artificial limit change.

**Tech Stack:** React 19, `@tanstack/react-virtual`, Vitest, Tailwind CSS

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/ui/src/mentions/components/MentionPanel.tsx` | Add virtual scrolling to option list |
| Modify | `packages/ui/src/mentions/providers/fileMentionProvider.ts` | Remove hard limit of 100 |
| Modify | `packages/ui/src/mentions/mentionSearch.ts` | Add soft display cap constant (1000) as safety net |
| Create | `packages/ui/test/mentionPanel.test.ts` | Unit tests for virtual scroll behavior |
| Modify | `packages/ui/test/mentionSearch.test.ts` | Add test for large result set handling |

---

### Task 1: Add `@tanstack/react-virtual` dependency

**Files:**
- Modify: `packages/ui/package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd packages/ui && npm install @tanstack/react-virtual
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@tanstack/react-virtual')" 2>/dev/null && echo OK || echo FAIL
```

Expected: OK

- [ ] **Step 3: Commit**

```bash
git add packages/ui/package.json package-lock.json
git commit -m "chore: add @tanstack/react-virtual for mention panel virtualization"
```

---

### Task 2: Remove hard limit in fileMentionProvider

**Files:**
- Modify: `packages/ui/src/mentions/providers/fileMentionProvider.ts:8,85-91`
- Modify: `packages/ui/src/mentions/mentionSearch.ts`
- Modify: `packages/ui/test/mentionSearch.test.ts`

- [ ] **Step 1: Write the failing test — large result set is not truncated**

In `packages/ui/test/mentionSearch.test.ts`, add:

```typescript
describe("filterMentionItemsWithOptions – no hard cap", () => {
  const manyItems: MentionItem[] = Array.from({ length: 500 }, (_, i) => ({
    id: `file:src/file${i}.ts`,
    category: "files" as const,
    label: `file${i}.ts`,
    description: `src/file${i}.ts`,
    value: `src/file${i}.ts`,
    markdown: `[src/file${i}.ts](src/file${i}.ts)`,
    keywords: [],
  }));

  it("returns all matching items when no explicit limit is set", () => {
    const result = filterMentionItemsWithOptions(manyItems, "file");
    expect(result.length).toBe(500);
  });

  it("respects an explicit limit when provided", () => {
    const result = filterMentionItemsWithOptions(manyItems, "file", { limit: 10 });
    expect(result.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/dev/workspace/z-code && npx vitest run packages/ui/test/mentionSearch.test.ts
```

Expected: first assertion FAILS — `filterMentionItemsWithOptions` without explicit limit still gets capped somewhere if called from within the provider path.

(Note: `filterMentionItemsWithOptions` itself does not cap by default — the limit is only passed by `fileMentionProvider`. The test should actually pass already since the function without `options.limit` returns all items. If it passes, that confirms the function layer is fine and the cap is purely in the provider. Proceed to Step 3 regardless.)

- [ ] **Step 3: Remove the hard limit constant from fileMentionProvider**

In `packages/ui/src/mentions/providers/fileMentionProvider.ts`, make these changes:

Remove the constant:
```typescript
// DELETE this line:
const FILE_MENTION_RESULT_LIMIT = 100;
```

Update the `useMemo` that calls `filterMentionItemsWithOptions` — remove the `limit` option:

```typescript
  const items = useMemo(
    () => filterMentionItemsWithOptions(allItems, query),
    [allItems, query],
  );
```

- [ ] **Step 4: Add a safety-net display cap constant in mentionSearch.ts**

In `packages/ui/src/mentions/mentionSearch.ts`, add a default max display constant and apply it in `filterMentionItemsWithOptions` only when no explicit limit is provided, to prevent accidentally rendering 50k+ items even with virtualization:

```typescript
/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
export const MENTION_DISPLAY_CAP = 1000;
```

Update `filterMentionItemsWithOptions`:

```typescript
export function filterMentionItemsWithOptions(
  items: MentionItem[],
  query: string,
  options: FilterMentionItemsOptions = {},
): MentionItem[] {
  const effectiveLimit = options.limit ?? MENTION_DISPLAY_CAP;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return options.requireQuery ? [] : applyMentionItemLimit(items, effectiveLimit);
  }

  return applyMentionItemLimit(
    sortScoredItems(
      items,
      (item) => {
        const labelScore = scoreFuzzyMatch(item.label, normalizedQuery);
        const descriptionScore = scoreFuzzyMatch(item.description, normalizedQuery);
        const valueScore = scoreFuzzyMatch(item.value, normalizedQuery);
        const keywordScore = Math.min(
          ...(item.keywords ?? []).map((keyword) => {
            const score = scoreFuzzyMatch(keyword, normalizedQuery);
            return score === null ? Number.POSITIVE_INFINITY : score + 300;
          }),
          Number.POSITIVE_INFINITY,
        );
        const bestScore = Math.min(
          labelScore ?? Number.POSITIVE_INFINITY,
          valueScore !== null ? valueScore + 25 : Number.POSITIVE_INFINITY,
          descriptionScore !== null ? descriptionScore + 100 : Number.POSITIVE_INFINITY,
          keywordScore,
        );

        return Number.isFinite(bestScore) ? bestScore : null;
      },
      (item) => item.label,
    ),
    effectiveLimit,
  );
}
```

- [ ] **Step 5: Run the test again**

```bash
cd /Users/dev/workspace/z-code && npx vitest run packages/ui/test/mentionSearch.test.ts
```

Expected: ALL PASS. The 500-item test passes (under the 1000 cap); the limit-10 test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/mentions/providers/fileMentionProvider.ts packages/ui/src/mentions/mentionSearch.ts packages/ui/test/mentionSearch.test.ts
git commit -m "feat: remove hard 100-item cap from mention panel, add 1000-item safety-net display cap"
```

---

### Task 3: Virtualize MentionPanel rendering

This is the core task. Replace the naive `section.options.map(...)` DOM render with `@tanstack/react-virtual`'s `useVirtualizer`.

**Files:**
- Modify: `packages/ui/src/mentions/components/MentionPanel.tsx`

- [ ] **Step 1: Flatten sections into a single virtual list with section headers**

The current MentionPanel renders sections → options. For virtualization, we need a single flat list where some rows are "section headers" and most are "option rows". This lets us use a single virtualizer.

Replace the entire content of `packages/ui/src/mentions/components/MentionPanel.tsx` with:

```tsx
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface MentionPanelOption {
  id: string;
  label: string;
  description: string;
  meta?: ReactNode;
}

export interface MentionPanelSection {
  id: string;
  title: string;
  options: MentionPanelOption[];
  emptyText: string;
  loadingText?: string;
  loading?: boolean;
  errorText?: string | null;
}

interface MentionPanelProps {
  title: string;
  description: string;
  trigger: string;
  sections: MentionPanelSection[];
  emptyText: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

type VirtualRow =
  | { kind: "status"; sectionId: string; content: "loading" | "error" | "empty"; text: string }
  | { kind: "option"; sectionId: string; option: MentionPanelOption; flatOptionIndex: number };

const OPTION_ROW_HEIGHT = 44;
const STATUS_ROW_HEIGHT = 40;

function buildVirtualRows(sections: MentionPanelSection[]): VirtualRow[] {
  const rows: VirtualRow[] = [];
  let flatOptionIndex = 0;

  for (const section of sections) {
    if (section.errorText) {
      rows.push({ kind: "status", sectionId: section.id, content: "error", text: section.errorText });
    } else if (section.loading) {
      rows.push({ kind: "status", sectionId: section.id, content: "loading", text: section.loadingText ?? section.emptyText });
    } else if (section.options.length === 0) {
      rows.push({ kind: "status", sectionId: section.id, content: "empty", text: section.emptyText });
    } else {
      for (const option of section.options) {
        rows.push({ kind: "option", sectionId: section.id, option, flatOptionIndex });
        flatOptionIndex += 1;
      }
    }
  }

  return rows;
}

export function MentionPanel({
  title,
  description,
  sections,
  emptyText,
  selectedIndex,
  onSelect,
  onHover,
}: MentionPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const virtualRows = useMemo(() => buildVirtualRows(sections), [sections]);

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) =>
      virtualRows[index]?.kind === "option" ? OPTION_ROW_HEIGHT : STATUS_ROW_HEIGHT,
    overscan: 8,
  });

  // Scroll selected option into view
  const selectedVirtualIndex = useMemo(() => {
    return virtualRows.findIndex(
      (row) => row.kind === "option" && row.flatOptionIndex === selectedIndex,
    );
  }, [virtualRows, selectedIndex]);

  useEffect(() => {
    if (selectedVirtualIndex >= 0) {
      virtualizer.scrollToIndex(selectedVirtualIndex, { align: "auto" });
    }
  }, [selectedVirtualIndex, virtualizer]);

  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-xl border border-outline/60 bg-popover shadow-[0_18px_45px_rgba(15,23,42,0.18)]">
      <div className="flex items-center justify-between border-b border-outline/60 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] text-on-surface-muted">{description}</p>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="h-56 overflow-y-auto p-1"
        role="listbox"
        aria-label={title}
      >
        {virtualRows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-3 text-xs text-on-surface-muted">
            {emptyText}
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = virtualRows[virtualItem.index];
              if (!row) return null;

              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.kind === "status" ? (
                    <StatusRow row={row} />
                  ) : (
                    <OptionRow
                      row={row}
                      isSelected={row.flatOptionIndex === selectedIndex}
                      onSelect={onSelect}
                      onHover={onHover}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusRow({ row }: { row: Extract<VirtualRow, { kind: "status" }> }) {
  if (row.content === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-xl px-5 py-2 text-xs text-on-surface-muted">
        <span className="flex gap-1">
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/60"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/60"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/60"
            style={{ animationDelay: "300ms" }}
          />
        </span>
        <span>{row.text}</span>
      </div>
    );
  }

  if (row.content === "error") {
    return (
      <div className="rounded-xl px-5 py-2 text-xs text-red-500">
        {row.text}
      </div>
    );
  }

  return (
    <div className="rounded-xl px-5 py-2 text-xs text-on-surface-muted">
      {row.text}
    </div>
  );
}

function OptionRow({
  row,
  isSelected,
  onSelect,
  onHover,
}: {
  row: Extract<VirtualRow, { kind: "option" }>;
  isSelected: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const { option, flatOptionIndex } = row;

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      className={`flex w-full items-start gap-3 rounded-xl border px-5 py-2 text-left transition-colors ${
        isSelected
          ? "border-outline/60 bg-surface-raised text-on-surface shadow-sm"
          : "border-transparent text-on-surface-muted hover:bg-surface-raised/70 hover:text-on-surface"
      }`}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect(flatOptionIndex);
      }}
      onMouseEnter={() => onHover(flatOptionIndex)}
    >
      <span className="min-w-0 flex-1 flex">
        <span className="flex items-center gap-2 flex-auto">
          <span className="truncate text-xs font-medium text-on-surface">
            {option.label}
          </span>
          {option.meta ? (
            <span className="shrink-0 text-[10px] text-on-surface-muted">
              {option.meta}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-[11px] text-on-surface-muted">
          {option.description}
        </span>
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Verify the app builds**

```bash
cd /Users/dev/workspace/z-code && npm run build
```

Expected: No TypeScript or build errors.

- [ ] **Step 3: Manual smoke test**

Open the app, type `@` in the chat input. Verify:
- Panel opens with file list
- Arrow keys navigate and scroll correctly
- Typing a query filters the list
- Selecting an item inserts the mention
- Scrolling is smooth with no visible jank

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/mentions/components/MentionPanel.tsx
git commit -m "feat: virtualize mention panel list with @tanstack/react-virtual"
```

---

### Task 4: Unit tests for virtualized MentionPanel

**Files:**
- Create: `packages/ui/test/mentionPanel.test.ts`

- [ ] **Step 1: Write tests for buildVirtualRows helper**

Since `buildVirtualRows` is the key logic that flattens sections into virtual rows, extract it as a named export for testing (or test it indirectly). The simplest approach: export it from `MentionPanel.tsx` and test the flattening logic directly.

In `packages/ui/src/mentions/components/MentionPanel.tsx`, add `export` to the `buildVirtualRows` function:

```typescript
export function buildVirtualRows(sections: MentionPanelSection[]): VirtualRow[] {
```

Also export the `VirtualRow` type:

```typescript
export type VirtualRow =
```

Create `packages/ui/test/mentionPanel.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildVirtualRows,
  type MentionPanelSection,
} from "../src/mentions/components/MentionPanel.js";

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt-${i}`,
    label: `Option ${i}`,
    description: `Description ${i}`,
  }));
}

describe("buildVirtualRows", () => {
  it("returns empty array for empty sections", () => {
    expect(buildVirtualRows([])).toEqual([]);
  });

  it("produces one option row per option with correct flatOptionIndex", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(3), emptyText: "No files" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "option")).toBe(true);

    const indices = rows
      .filter((r): r is Extract<typeof r, { kind: "option" }> => r.kind === "option")
      .map((r) => r.flatOptionIndex);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("shows loading status row when section is loading", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files", loading: true, loadingText: "Loading..." },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "loading", text: "Loading..." });
  });

  it("shows error status row when section has error", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files", errorText: "Failed to load" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "error", text: "Failed to load" });
  });

  it("shows empty status row when section has no options and is not loading", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files found" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "empty", text: "No files found" });
  });

  it("assigns continuous flatOptionIndex across multiple sections", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(2), emptyText: "" },
      { id: "symbols", title: "Symbols", options: makeOptions(3), emptyText: "" },
    ];
    const rows = buildVirtualRows(sections);
    const optionRows = rows.filter(
      (r): r is Extract<typeof r, { kind: "option" }> => r.kind === "option",
    );
    expect(optionRows.map((r) => r.flatOptionIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles large option sets efficiently", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(1000), emptyText: "" },
    ];
    const start = performance.now();
    const rows = buildVirtualRows(sections);
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(1000);
    expect(elapsed).toBeLessThan(50); // should be essentially instant
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/dev/workspace/z-code && npx vitest run packages/ui/test/mentionPanel.test.ts
```

Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/test/mentionPanel.test.ts packages/ui/src/mentions/components/MentionPanel.tsx
git commit -m "test: add unit tests for MentionPanel virtual row building"
```

---

### Task 5: Final integration verification

- [ ] **Step 1: Run all existing mention-related tests**

```bash
cd /Users/dev/workspace/z-code && npx vitest run packages/ui/test/mentionSearch.test.ts packages/ui/test/mentionPanel.test.ts
```

Expected: ALL PASS

- [ ] **Step 2: Run the full UI package test suite**

```bash
cd /Users/dev/workspace/z-code && npx vitest run packages/ui/test/
```

Expected: ALL PASS, no regressions.

- [ ] **Step 3: Build check**

```bash
cd /Users/dev/workspace/z-code && npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 4: Manual E2E smoke test**

Open the app and verify:
1. Type `@` — panel opens, shows files (loading indicator → list)
2. Scroll down — smooth virtual scrolling, no blank gaps
3. Type a query (e.g., `pack`) — list filters instantly
4. Arrow down 20+ times — scrolling follows selection smoothly
5. Press Enter — mention inserted correctly
6. Open `@` on a large workspace (1000+ files) — no visible lag

- [ ] **Step 5: Commit (if any adjustments were needed)**

```bash
git add -A
git commit -m "fix: address integration issues from virtual scroll migration"
```

## 2026-04-03 补充

- 文件 mention 面板的每个候选项统一复用 `packages/ui/src/lib/fileDisplay.tsx`。
- 这样 `@` 面板里的文件图标、文件名、目录路径会和输入框中的 mention token 保持一致，减少同一路径在不同位置展示不一致的问题。
