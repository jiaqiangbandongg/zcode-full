import { useState } from "react";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { ZCodeAppLogo } from "@zcode/ui/app-logo";
import { renderOAuthProviderIcon } from "@zcode/ui/oauth-provider-icon";
import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";
import { Button } from "@zcode/ui";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebLoginPageProps {
  onLogin: (provider: WebOAuthProviderId) => void;
}

export function WebLoginPage({ onLogin }: WebLoginPageProps) {
  const copy = getWebAuthCopy();
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <ZCodeAppLogo className="size-10" />
          <div className="min-w-0">
            <div className="text-ui-xs font-medium text-foreground">{copy.brand}</div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.loginTitle}</h1>
          </div>
        </div>
        <p className="mb-5 text-ui-xs leading-6 text-foreground-subtle">{copy.loginDescription}</p>
        <div className="space-y-2">
          {[ZAI_PROVIDER_ID, BIGMODEL_PROVIDER_ID].map((provider) => (
            <Button
              key={provider}
              type="button"
              size="lg"
              className="w-full"
              disabled={isSubmitting}
              onClick={() => {
                setIsSubmitting(true);
                onLogin(provider);
              }}
            >
              {renderOAuthProviderIcon(provider, "size-4")}
              <span>{copy.loginAction[provider]}</span>
              <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
                {copy.loginRegion[provider]}
              </span>
            </Button>
          ))}
        </div>
      </section>
    </main>
  );
}
