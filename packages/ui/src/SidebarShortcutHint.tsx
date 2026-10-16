export function SidebarShortcutHint({ shortcut, label }: { shortcut: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-ui-xs text-foreground-subtle">
      <kbd className="shrink-0 rounded-sm bg-tooltip-tag px-1.5 py-0.5 font-mono text-ui-xs text-foreground">
        {shortcut}
      </kbd>
      <span>{label}</span>
    </div>
  );
}
