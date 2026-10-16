import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBotPrivateDeliveryRetry } from "@/hooks/useBotPrivateDeliveryRetry.js";

export function PrivateDeliveryRetry({ botId, deliveryId }: { botId: string; deliveryId: string }) {
  const { intl } = useZCodeIntl();
  const { state, retry } = useBotPrivateDeliveryRetry(botId, deliveryId);
  if (state === "done") return null;
  return (
    <div className="space-y-2 text-ui-base">
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "bots.privateDelivery.retryHint" })}
      </p>
      {state === "error" ? (
        <p role="alert" className="text-destructive">
          {intl.formatMessage({ id: "bots.privateDelivery.retryFailed" })}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={state === "sending"}
        onClick={() => void retry()}
      >
        {intl.formatMessage({
          id: state === "sending" ? "common.loading" : "bots.privateDelivery.retry",
        })}
      </Button>
    </div>
  );
}
