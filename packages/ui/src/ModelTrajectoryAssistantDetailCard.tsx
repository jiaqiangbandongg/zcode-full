import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, type LucideIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { Badge } from "@/components/ui/badge.js";

export function AssistantDetailCard({
  icon: Icon,
  label,
  summary,
  trailing,
  children,
}: {
  icon: LucideIcon;
  label: string;
  summary: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible
      data-trajectory-assistant-detail-card=""
      data-trajectory-message-expanded-card=""
      className="group rounded-md bg-surface"
    >
      <CollapsibleTrigger
        aria-label={label}
        className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui-sm text-foreground-subtle transition-colors hover:bg-hover"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtlest">
          <Icon className="size-3.5 group-hover:hidden" />
          <ChevronRightIcon className="hidden size-3.5 group-hover:block group-data-[state=open]:hidden" />
          <ChevronDownIcon className="hidden size-3.5 group-data-[state=open]:group-hover:block" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground-subtlest">
          {summary}
        </span>
        {trailing ? (
          <Badge
            data-trajectory-assistant-detail-id=""
            variant="outline"
            className="max-w-[40%] truncate font-mono text-foreground-subtle"
            title={typeof trailing === "string" ? trailing : undefined}
          >
            {trailing}
          </Badge>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 px-2 pb-2 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function contentSummary(content: string): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "—"
  );
}
