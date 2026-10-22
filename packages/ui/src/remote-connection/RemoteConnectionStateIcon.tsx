import { Cloud, CloudAlert, CloudOff, X, LoaderCircle } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

const ICONS = {
  cloud: Cloud,
  spinner: LoaderCircle,
  "cloud-off": CloudOff,
  "cloud-alert": CloudAlert,
  "cloud-x": Cloud,
};

/** 项目行仅保留这一个状态图标位；已连接项目使用中性云。 */
export function RemoteConnectionStateIcon({
  presentation,
  project = false,
}: {
  presentation: RemoteConnectionPresentation;
  project?: boolean;
}) {
  const Icon = ICONS[presentation.icon];
  if (presentation.icon === "cloud-x")
    return (
      <span
        data-remote-state-icon="cloud-x"
        className={cn("relative inline-flex size-4 shrink-0", presentation.foreground)}
      >
        <Cloud aria-hidden="true" className="size-4" />
        <X aria-hidden="true" className="absolute -bottom-1 -right-1 size-3 bg-inherit" />
      </span>
    );
  return (
    <Icon
      aria-hidden="true"
      data-remote-state-icon={presentation.icon}
      className={cn(
        "size-4 shrink-0",
        project && presentation.status === "online"
          ? "text-remote-foreground-muted"
          : presentation.foreground,
        presentation.icon === "spinner" && "animate-spin motion-reduce:animate-none",
      )}
    />
  );
}
