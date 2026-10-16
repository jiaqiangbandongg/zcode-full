import { useState } from "react";
import { Button } from "@zcode/ui";
import type { UserInfo } from "@zcode/shared";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebLoggedInWaitingPageProps {
  user: UserInfo;
  onLogout?: () => Promise<void> | void;
}

function getAvatarFallback(user: UserInfo): string {
  return (user.displayName || user.username || "Z").trim().slice(0, 1).toUpperCase();
}

export function WebLoggedInWaitingPage({ onLogout, user }: WebLoggedInWaitingPageProps) {
  const copy = getWebAuthCopy();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="size-10 shrink-0 rounded-full border border-border object-cover"
            />
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-ui-xs font-medium text-foreground">
              {getAvatarFallback(user)}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-ui-xs text-foreground-subtle">{copy.signedInAs}</div>
            <div className="truncate text-ui-xs font-medium text-foreground">
              {user.displayName || user.username}
            </div>
          </div>
        </div>
        <h1 className="text-ui-lg font-medium text-foreground">{copy.waitingTitle}</h1>
        <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
          {copy.waitingDescription}
        </p>
        {onLogout ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="mt-5 w-full"
            disabled={isLoggingOut}
            onClick={() => {
              setIsLoggingOut(true);
              void Promise.resolve(onLogout()).finally(() => {
                setIsLoggingOut(false);
              });
            }}
          >
            {copy.logoutAction}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
