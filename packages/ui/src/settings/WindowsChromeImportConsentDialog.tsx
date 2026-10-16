import { LoaderCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function WindowsChromeImportConsentDialog({
  checked,
  importing,
  open,
  onCheckedChange,
  onConfirm,
  onOpenChange,
}: {
  checked: boolean;
  importing: boolean;
  open: boolean;
  onCheckedChange: (checked: boolean) => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.browser.import.adminConfirmTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.browser.import.adminConfirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground">
          <Checkbox
            checked={checked}
            disabled={importing}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            aria-label={intl.formatMessage({ id: "settings.browser.import.adminConsent" })}
          />
          <span>{intl.formatMessage({ id: "settings.browser.import.adminConsent" })}</span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={importing}>
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!checked || importing}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {importing ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "settings.browser.import.adminConfirmAction" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
