import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function getScratchWorkspaceLocationHint(name: string) {
  return `~/ZCodeProject/${name.trim()}`;
}

export function getScratchWorkspaceNameErrorKind(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "required";
  }

  if (/[\\/]/.test(trimmedName)) {
    return "separator";
  }

  return null;
}

function formatScratchWorkspaceNameError(
  name: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
) {
  const errorKind = getScratchWorkspaceNameErrorKind(name);
  if (errorKind === "required") {
    return intl.formatMessage({ id: "chat.empty.createWorkspace.error.required" });
  }

  if (errorKind === "separator") {
    return intl.formatMessage({ id: "chat.empty.createWorkspace.error.separator" });
  }

  return null;
}

export function ScratchWorkspaceDialog({
  open,
  onOpenChange,
  onCreateScratchWorkspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateScratchWorkspace: (name: string) => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedName = name.trim();
  const locationHint = getScratchWorkspaceLocationHint(name);

  const handleSubmit = async () => {
    const validationError = formatScratchWorkspaceNameError(name, intl);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const createdPath = await onCreateScratchWorkspace(trimmedName);
      if (createdPath) {
        onOpenChange(false);
        setName("");
      }
    } catch (err) {
      logger.error("[ChatEmptyWorkspacePreviewMenu] 创建空 workspace 失败", err);
      setError(intl.formatMessage({ id: "chat.empty.createWorkspace.error.createFailed" }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setName("");
          setError(null);
          setSubmitting(false);
        } else {
          window.requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    >
      <DialogContent className="max-w-xl overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-6 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>
              {intl.formatMessage({ id: "chat.empty.createWorkspace.title" })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <Input
              ref={inputRef}
              value={name}
              size="lg"
              placeholder={intl.formatMessage({
                id: "chat.empty.createWorkspace.placeholder",
              })}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setName(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            <p className="break-all text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.empty.createWorkspace.locationHint" },
                { path: locationHint },
              )}
            </p>
            {error ? <p className="text-ui-base text-destructive">{error}</p> : null}
          </div>
          <DialogFooter className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              disabled={submitting || !trimmedName}
              onClick={() => void handleSubmit()}
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
