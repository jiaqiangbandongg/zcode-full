import { useCallback, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside } from "@/remote-connection/remoteConnectionHistoryPopover.js";

function matchesSuggestion(value: string, query: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return normalizedValue.includes(normalizedQuery);
}

export function RemoteConnectionHistoryInput({
  containerClassName,
  suggestionWidth,
  label,
  placeholder,
  value,
  suggestions,
  emptyText,
  onChange,
  ...inputProps
}: {
  containerClassName?: string;
  suggestionWidth?: string;
  label?: string;
  placeholder: string;
  value: string;
  suggestions: string[];
  emptyText: string;
  onChange: (value: string) => void;
} & Omit<
  ComponentProps<typeof Input>,
  "children" | "onChange" | "placeholder" | "size" | "value"
>) {
  const generatedId = useId();
  const inputId = inputProps.id ?? generatedId;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [filterWithCurrentValue, setFilterWithCurrentValue] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keepInputFocusOnOpenRef = useRef(false);
  const suppressOpenUntilRef = useRef(0);

  const filteredSuggestions = useMemo(() => {
    if (!filterWithCurrentValue) {
      return suggestions;
    }

    return suggestions.filter((item) => matchesSuggestion(item, value));
  }, [filterWithCurrentValue, suggestions, value]);

  const requestOpenFromInput = useCallback(
    (options?: { resetFilter?: boolean }) => {
      if (Date.now() < suppressOpenUntilRef.current || suggestions.length === 0) {
        return;
      }

      if (options?.resetFilter !== false) {
        setFilterWithCurrentValue(false);
      }

      setActiveIndex(-1);
      keepInputFocusOnOpenRef.current = true;
      setOpen(true);
    },
    [suggestions.length],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      return;
    }

    keepInputFocusOnOpenRef.current = false;
    setFilterWithCurrentValue(false);
  }, []);

  const selectSuggestion = (selected: string) => {
    onChange(selected);
    setFilterWithCurrentValue(false);
    suppressOpenUntilRef.current = Date.now() + 120;
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div ref={containerRef} className={cn("w-full", containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className="mb-1.5 block text-ui-sm text-remote-foreground-muted">
          {label}
        </label>
      ) : null}
      <Popover open={open && suggestions.length > 0} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <Input
            id={inputId}
            ref={inputRef}
            size="lg"
            placeholder={placeholder}
            value={value}
            onFocus={() => requestOpenFromInput()}
            onClick={() => requestOpenFromInput()}
            onChange={(event) => {
              onChange(event.target.value);
              setFilterWithCurrentValue(true);
              requestOpenFromInput({ resetFilter: false });
            }}
            autoComplete="off"
            {...inputProps}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={open ? `${generatedId}-list` : undefined}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${generatedId}-option-${activeIndex}` : undefined
            }
            onKeyDown={(event) => {
              inputProps.onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (!filteredSuggestions.length) return;
                event.preventDefault();
                if (!open) requestOpenFromInput();
                setActiveIndex((index) =>
                  event.key === "ArrowDown"
                    ? (index + 1) % filteredSuggestions.length
                    : index <= 0
                      ? filteredSuggestions.length - 1
                      : index - 1,
                );
              } else if (open && event.key === "Enter" && activeIndex >= 0) {
                event.preventDefault();
                const selected = filteredSuggestions[activeIndex];
                if (selected !== undefined) selectSuggestion(selected);
              } else if (open && (event.key === "Escape" || event.key === "Tab")) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                }
                setOpen(false);
                setActiveIndex(-1);
              }
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
          style={{
            width: suggestionWidth ?? "var(--radix-popover-trigger-width)",
          }}
          onInteractOutside={(event) => {
            const targetNode = event.target;
            if (
              shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
                isTargetInsideContainer:
                  targetNode instanceof Node && containerRef.current?.contains(targetNode) === true,
              })
            ) {
              // 首次鼠标点击输入框时会先触发 focus 打开建议列表，
              // 随后的同一次 click 又会被 Popover 视为“内容外点击”而立刻关闭。
              // 这里把来自当前输入框容器的交互排除掉，避免出现第一次 focus 连续闪两次。
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Popover 默认会把焦点抢到弹层内，输入框一旦失焦，用户就没法边看历史边继续输入过滤。
            // 这里在“由输入框触发打开”时拦截自动聚焦，把焦点留在输入框里，保证 focus 展示和连续输入都成立。
            if (!keepInputFocusOnOpenRef.current) {
              return;
            }

            event.preventDefault();
            inputRef.current?.focus();
            keepInputFocusOnOpenRef.current = false;
          }}
        >
          <div
            id={`${generatedId}-list`}
            role="listbox"
            aria-label={label ?? placeholder}
            className="max-h-56 overflow-y-auto rounded-lg"
          >
            {filteredSuggestions.length === 0 ? (
              <p className="px-3 py-5 text-ui-base text-remote-foreground-muted">{emptyText}</p>
            ) : (
              filteredSuggestions.map((item, index) => (
                <div
                  key={item}
                  id={`${generatedId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  ref={(element) => {
                    if (index === activeIndex) element?.scrollIntoView({ block: "nearest" });
                  }}
                  className={cn(
                    "min-h-8 cursor-pointer rounded-md px-3 py-1.5 text-ui-base text-foreground hover:bg-menu-hover",
                    index === activeIndex && "bg-menu-hover",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(item)}
                >
                  <span className="block truncate">{item}</span>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
