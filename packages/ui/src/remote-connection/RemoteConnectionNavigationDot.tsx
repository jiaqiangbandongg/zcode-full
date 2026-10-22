import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

export function RemoteConnectionNavigationDot({
  presentation,
}: {
  presentation: RemoteConnectionPresentation;
}) {
  const { intl } = useZCodeIntl();
  return (
    <span
      role="img"
      data-remote-navigation-status={presentation.status}
      aria-label={intl.formatMessage({ id: presentation.shortMessageId })}
      className={cn("ml-auto size-1.5 shrink-0 rounded-full", presentation.dot)}
    />
  );
}
