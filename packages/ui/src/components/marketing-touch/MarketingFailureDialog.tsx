import { InfoIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";

export function MarketingFailureDialog({
  message,
  title,
  acknowledge,
  onClose,
}: {
  message: string;
  title: string;
  acknowledge: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="marketing-failure-dialog"
        className="sm:max-w-sm"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {/* Alert 默认卡片外观会形成双层容器；这里只保留提示语义和图文布局。 */}
        <Alert className="min-w-0 border-0 bg-transparent p-0">
          <InfoIcon aria-hidden="true" className="size-4" />
          <DialogDescription asChild>
            {/* 服务端文案只能作为文本，防止 HTML/Markdown 被误当作可执行或可点击内容。 */}
            <AlertDescription
              data-slot="alert-description"
              className="min-w-0 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-foreground"
            >
              {message}
            </AlertDescription>
          </DialogDescription>
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>{acknowledge}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
