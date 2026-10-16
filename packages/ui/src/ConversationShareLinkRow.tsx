import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ConversationShareLinkRow({
  isPublic,
  pending,
  shareUrl,
  onOpen,
  onCopy,
}: {
  isPublic: boolean;
  pending: boolean;
  shareUrl: string | null;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <div className="flex min-w-0 items-center gap-3">
        {isPublic && pending ? (
          <div
            role="status"
            aria-label={intl.formatMessage({ id: "conversationShare.generatingLink" })}
            className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-input-border bg-input px-3 text-ui-base text-foreground-subtle"
          >
            <Spinner aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">
              {intl.formatMessage({ id: "conversationShare.generatingLink" })}
            </span>
          </div>
        ) : isPublic && shareUrl ? (
          <button
            type="button"
            role="link"
            onClick={onOpen}
            aria-label={intl.formatMessage({ id: "conversationShare.openLink" })}
            title={shareUrl}
            className="group flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg border border-input-border bg-input px-3 text-left text-ui-base text-foreground outline-none transition-colors hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
          >
            <span className="min-w-0 flex-1 truncate">{shareUrl}</span>
            <ArrowUpRight
              data-conversation-share-open-icon="true"
              aria-hidden="true"
              strokeWidth={1.33}
              // Bug 根因：opacity-0 仍占用 flex 宽度，导致默认态 URL 提前截断；隐藏后仅在交互态参与布局。
              className="hidden size-4 shrink-0 group-hover:block group-focus-visible:block"
            />
          </button>
        ) : null}
        <Button
          type="button"
          size="lg"
          disabled={pending}
          onClick={onCopy}
          className="ml-auto h-9 bg-background px-4 text-foreground hover:bg-background/80"
        >
          {intl.formatMessage({ id: "conversationShare.copyLink" })}
        </Button>
      </div>
    </div>
  );
}
