import { Search, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

export function SettingsSearchInput({
  className,
  clearLabel = "Clear search",
  clearTestId,
  containerClassName,
  onClear,
  trailingAction,
  ...props
}: ComponentProps<typeof Input> & {
  clearLabel?: string;
  clearTestId?: string;
  containerClassName?: string;
  onClear?: () => void;
  trailingAction?: ReactNode;
}) {
  const canClear = Boolean(onClear && props.value && !props.disabled);

  return (
    <div className={cn("relative", containerClassName)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle"
        aria-hidden="true"
      />
      <Input
        {...props}
        type="search"
        size="lg"
        className={cn(
          "h-9 rounded-xl pl-9 [&::-webkit-search-cancel-button]:appearance-none",
          (canClear || trailingAction) && "pr-9",
          canClear && trailingAction && "pr-16",
          className,
        )}
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
        {canClear ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={clearLabel}
            data-testid={clearTestId}
            onClick={onClear}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        {trailingAction}
      </div>
    </div>
  );
}
