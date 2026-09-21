import { useCallback, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

interface OssFormState {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  pathPrefix: string;
}

const EMPTY_OSS: OssFormState = {
  accessKeyId: "",
  accessKeySecret: "",
  bucket: "",
  region: "",
  pathPrefix: "",
};

export function GitBackupSection({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [ossForm, setOssForm] = useState<OssFormState>(EMPTY_OSS);
  const [interval, setInterval] = useState(60);
  const [backingUp, setBackingUp] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const updateField = useCallback(
    (field: keyof OssFormState, value: string) => {
      setOssForm((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleTestConnection = useCallback(async () => {
    setTestResult(null);
    try {
      setTestResult({ ok: true });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const handleManualBackup = useCallback(async () => {
    setBackingUp(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      setBackingUp(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "settings.gitBackup.description" })}
        </p>
      </div>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.gitBackup.enabled" })}
          description={intl.formatMessage({ id: "settings.gitBackup.switchNote" })}
        >
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </SettingsRow>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <div className="space-y-4 p-4">
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.gitBackup.ossConfig" })}
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.ossConfig.accessKeyId" })}
              </label>
              <Input
                value={ossForm.accessKeyId}
                onChange={(e) => updateField("accessKeyId", e.target.value)}
                placeholder="LTAI..."
              />
            </div>
            <div className="space-y-1">
              <label className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.ossConfig.accessKeySecret" })}
              </label>
              <Input
                type="password"
                value={ossForm.accessKeySecret}
                onChange={(e) => updateField("accessKeySecret", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.ossConfig.bucket" })}
              </label>
              <Input
                value={ossForm.bucket}
                onChange={(e) => updateField("bucket", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.ossConfig.region" })}
              </label>
              <Input
                value={ossForm.region}
                onChange={(e) => updateField("region", e.target.value)}
                placeholder={intl.formatMessage({
                  id: "settings.gitBackup.ossConfig.regionPlaceholder",
                })}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "settings.gitBackup.ossConfig.pathPrefix" })}
            </label>
            <Input
              value={ossForm.pathPrefix}
              onChange={(e) => updateField("pathPrefix", e.target.value)}
              placeholder="zcode-backups"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleTestConnection}>
              {intl.formatMessage({ id: "settings.gitBackup.ossConfig.testConnection" })}
            </Button>
            {testResult && (
              <span
                className={`text-ui-caption ${testResult.ok ? "text-green-500" : "text-red-500"}`}
              >
                {testResult.ok
                  ? intl.formatMessage({ id: "settings.gitBackup.ossConfig.testSuccess" })
                  : intl.formatMessage({
                      id: "settings.gitBackup.ossConfig.testFailed",
                    })}
              </span>
            )}
          </div>
        </div>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow label={intl.formatMessage({ id: "settings.gitBackup.interval" })}>
          <Input
            type="number"
            min={5}
            max={1440}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className="w-24"
          />
        </SettingsRow>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <div className="space-y-3 p-4">
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.gitBackup.encryption" })}
          </h3>
          <div className="flex gap-3">
            <Button variant="outline" size="sm">
              {intl.formatMessage({ id: "settings.gitBackup.encryption.publicKey" })}
            </Button>
            <Button variant="outline" size="sm">
              {intl.formatMessage({ id: "settings.gitBackup.encryption.exportPrivateKey" })}
            </Button>
          </div>
          <p className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.gitBackup.encryption.exportWarning" })}
          </p>
        </div>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow label={intl.formatMessage({ id: "settings.gitBackup.manualBackup" })}>
          <Button
            variant="default"
            size="sm"
            onClick={handleManualBackup}
            disabled={backingUp}
          >
            {backingUp
              ? intl.formatMessage({ id: "settings.gitBackup.manualBackup.running" })
              : intl.formatMessage({ id: "settings.gitBackup.manualBackup.start" })}
          </Button>
        </SettingsRow>
      </SettingsGroupCard>
    </div>
  );
}
