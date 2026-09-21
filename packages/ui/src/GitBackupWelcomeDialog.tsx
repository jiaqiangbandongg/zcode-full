import { useCallback, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

interface GitBackupWelcomeDialogProps {
  open: boolean;
  onComplete: (config: {
    enabled: boolean;
    oss?: {
      accessKeyId: string;
      accessKeySecret: string;
      bucket: string;
      region: string;
      pathPrefix?: string;
    };
  }) => void;
}

export function GitBackupWelcomeDialog({ open, onComplete }: GitBackupWelcomeDialogProps) {
  const { intl } = useZCodeIntl();
  const [showOssForm, setShowOssForm] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");

  const handleEnable = useCallback(() => {
    if (!showOssForm) {
      setShowOssForm(true);
      return;
    }
    onComplete({
      enabled: true,
      oss: {
        accessKeyId,
        accessKeySecret,
        bucket,
        region,
        pathPrefix: pathPrefix || undefined,
      },
    });
  }, [showOssForm, accessKeyId, accessKeySecret, bucket, region, pathPrefix, onComplete]);

  const handleSkip = useCallback(() => {
    onComplete({ enabled: false });
  }, [onComplete]);

  if (!open) return null;

  const ossFormValid = accessKeyId.trim() && accessKeySecret.trim() && bucket.trim() && region.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl bg-popover p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand/10">
            <svg
              className="h-5 w-5 text-brand"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "gitBackup.welcome.title" })}
          </h2>
        </div>

        <p className="mb-6 text-ui-caption text-foreground-subtle leading-relaxed">
          {intl.formatMessage({ id: "gitBackup.welcome.description" })}
        </p>

        {showOssForm && (
          <div className="mb-6 space-y-3 rounded-lg border border-border p-4">
            <h3 className="text-ui-base font-medium">
              {intl.formatMessage({ id: "settings.gitBackup.ossConfig" })}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.gitBackup.ossConfig.accessKeyId" })}
                </label>
                <Input
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  placeholder="LTAI..."
                />
              </div>
              <div className="space-y-1">
                <label className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.gitBackup.ossConfig.accessKeySecret" })}
                </label>
                <Input
                  type="password"
                  value={accessKeySecret}
                  onChange={(e) => setAccessKeySecret(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.gitBackup.ossConfig.bucket" })}
                </label>
                <Input
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.gitBackup.ossConfig.region" })}
                </label>
                <Input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder={intl.formatMessage({
                    id: "settings.gitBackup.ossConfig.regionPlaceholder",
                  })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.ossConfig.pathPrefix" })}
              </label>
              <Input
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                placeholder="zcode-backups"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleSkip}>
            {intl.formatMessage({ id: "gitBackup.welcome.skipForNow" })}
          </Button>
          <Button
            variant="default"
            onClick={handleEnable}
            disabled={showOssForm && !ossFormValid}
          >
            {intl.formatMessage({ id: "gitBackup.welcome.enableNow" })}
          </Button>
        </div>

        {!showOssForm && (
          <p className="mt-4 text-center text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "gitBackup.welcome.skipNote" })}
          </p>
        )}
      </div>
    </div>
  );
}
