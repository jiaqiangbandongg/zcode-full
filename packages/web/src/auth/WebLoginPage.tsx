import { useState } from "react";
import { Button } from "@zcode/ui";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebLoginPageProps {
  onLogin: () => void;
}

export function WebLoginPage({ onLogin }: WebLoginPageProps) {
  const copy = getWebAuthCopy();
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-ui-xs font-semibold text-foreground">
            Z
          </div>
          <div className="min-w-0">
            <div className="text-ui-xs font-medium text-foreground">{copy.brand}</div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.loginTitle}</h1>
          </div>
        </div>
        <p className="mb-5 text-ui-xs leading-6 text-foreground-subtle">
          {copy.loginDescription}
        </p>
        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={isSubmitting}
          onClick={() => {
            setIsSubmitting(true);
            onLogin();
          }}
        >
          {copy.loginAction}
        </Button>
      </section>
    </main>
  );
}
