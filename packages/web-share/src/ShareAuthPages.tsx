import { useEffect, useState } from "react";
import type { WebAuthCallbackResult, WebAuthService } from "../../web/src/auth/webAuthService.js";

const pageClass =
  "flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground";
const cardClass = "w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm";

export function ShareCallbackPage({
  authService,
  onSuccess,
  onRetry,
}: {
  authService: Pick<WebAuthService, "handleCallback">;
  onSuccess: (result: WebAuthCallbackResult) => void;
  onRetry: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    authService
      .handleCallback(window.location.href)
      .then((result) => {
        if (mounted && result) onSuccess(result);
      })
      .catch((caught) => {
        if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      mounted = false;
    };
  }, [authService, onSuccess]);

  return (
    <main className={pageClass}>
      <section className={cardClass}>
        {error ? (
          <>
            <h1 className="text-ui-lg font-medium">Unable to sign in</h1>
            <p className="mt-2 text-ui-sm text-foreground-subtle">{error}</p>
            <button
              type="button"
              className="mt-5 h-9 w-full rounded-md bg-primary px-4 text-ui-base text-primary-foreground"
              onClick={onRetry}
            >
              Try again
            </button>
          </>
        ) : (
          <p className="text-ui-base text-foreground-subtle">Completing sign in…</p>
        )}
      </section>
    </main>
  );
}
