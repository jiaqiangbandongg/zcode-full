import { useState } from "react";

import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GenUiPage, GenUiPageSnapshot } from "../contract.js";
export function TweakPanel({ snapshot, page }: { snapshot: GenUiPageSnapshot; page: GenUiPage }) {
  const { groups, tweakValues: values, previewOriginal: preview } = snapshot;
  const { intl } = useZCodeIntl();
  const original = Object.fromEntries(
    groups.flatMap((group) => group.controls).map((control) => [control.id, control.value]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (id: string, value: string | number | boolean) => {
    const next = { ...values, [id]: value };
    page.setTweaks(next);
  };
  return (
    <div
      className="max-h-[40vh] space-y-3 overflow-y-auto p-3 text-ui-sm"
      data-testid="gen-ui-tweaks"
    >
      {groups.map((tweak, groupIndex) => (
        <fieldset key={groupIndex} className="space-y-3">
          <legend className="font-medium">{tweak.title}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {tweak.controls.map((control) => (
              <label key={control.id} className="flex items-center gap-3">
                <span className="min-w-20">{control.label}</span>
                {control.type === "select" ? (
                  <select
                    aria-label={control.label}
                    className="min-w-0 flex-1 rounded border bg-panel p-1"
                    value={String(values[control.id])}
                    onChange={(event) => change(control.id, event.target.value)}
                  >
                    {control.options.map((option) => (
                      <option
                        key={typeof option === "string" ? option : option.value}
                        value={typeof option === "string" ? option : option.value}
                      >
                        {typeof option === "string" ? option : option.label}
                      </option>
                    ))}
                  </select>
                ) : control.type === "toggle" ? (
                  <input
                    aria-label={control.label}
                    type="checkbox"
                    checked={Boolean(values[control.id])}
                    onChange={(event) => change(control.id, event.target.checked)}
                  />
                ) : (
                  <input
                    aria-label={control.label}
                    type={control.type === "color" ? "color" : "range"}
                    className="min-w-0 flex-1"
                    value={String(values[control.id])}
                    {...(control.type === "slider"
                      ? { min: control.min, max: control.max, step: control.step ?? 1 }
                      : {})}
                    onChange={(event) =>
                      change(
                        control.id,
                        control.type === "slider" ? Number(event.target.value) : event.target.value,
                      )
                    }
                  />
                )}
                {control.type === "slider" && (
                  <output>
                    {values[control.id]}
                    {control.unit}
                  </output>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            page.setTweaks(original);
          }}
        >
          {intl.formatMessage({ id: "genUi.reset" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={preview}
          onClick={() => {
            page.previewTweaks(!preview);
          }}
        >
          {intl.formatMessage({ id: "genUi.original" })}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await page.submitTweaks(values);
            } catch (reason) {
              setError(String(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          {intl.formatMessage({ id: "genUi.submit" })}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
