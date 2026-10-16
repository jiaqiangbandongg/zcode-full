import { RotateCcw, Search } from "lucide-react";
import {
  capabilityRelationNames,
  type CapabilityRelationType,
} from "@/data/productCapabilityMap.js";
import {
  relationTypes,
  type EdgeScope,
} from "@/capability-map/capabilityMapTypes.js";

export function CapabilityMapToolbar({
  edgeScope,
  enabledRelations,
  onEdgeScopeChange,
  onQueryChange,
  onReset,
  onToggleRelation,
  query,
}: {
  edgeScope: EdgeScope;
  enabledRelations: Set<CapabilityRelationType>;
  onEdgeScopeChange: (scope: EdgeScope) => void;
  onQueryChange: (query: string) => void;
  onReset: () => void;
  onToggleRelation: (type: CapabilityRelationType) => void;
  query: string;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
        <label className="relative min-w-0 flex-1">
          <span className="mb-1 block text-ui-sm font-medium text-foreground-subtle">
            查找能力节点
          </span>
          <Search className="pointer-events-none absolute bottom-2 left-2.5 size-4 text-foreground-subtlest" />
          <input
            className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-mobile-input-safe text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused md:text-ui-base"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="例如：App Usage、Start Plan、Agent Core、SSH"
            type="search"
            value={query}
          />
        </label>
        <label className="min-w-44">
          <span className="mb-1 block text-ui-sm font-medium text-foreground-subtle">
            关系范围
          </span>
          <select
            className="h-8 w-full rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground outline-none focus:border-input-border-focused focus:bg-input-focused"
            onChange={(event) =>
              onEdgeScopeChange(event.target.value as EdgeScope)
            }
            value={edgeScope}
          >
            <option value="all">全部关系</option>
            <option value="cross">仅跨群关系</option>
          </select>
        </label>
        <fieldset className="min-w-0">
          <legend className="mb-1 text-ui-sm font-medium text-foreground-subtle">
            连线类型
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {relationTypes.map((type) => (
              <label
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-ui-sm ${
                  enabledRelations.has(type)
                    ? "border-brand bg-selected text-foreground"
                    : "border-border bg-surface text-foreground-subtle"
                }`}
                key={type}
              >
                <input
                  checked={enabledRelations.has(type)}
                  className="accent-brand"
                  onChange={() => onToggleRelation(type)}
                  type="checkbox"
                />
                <i
                  aria-hidden="true"
                  className={`capability-relation-swatch capability-map-edge--${type}`}
                />
                {capabilityRelationNames[type]}
              </label>
            ))}
          </div>
        </fieldset>
        <button
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-ui-sm text-foreground hover:bg-surface-hover"
          onClick={onReset}
          type="button"
        >
          <RotateCcw className="size-3.5" />
          重置
        </button>
      </div>
    </section>
  );
}
