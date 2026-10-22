import type { ReactElement } from "react";
import { Button } from "@zcode/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@zcode/ui/dialog";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

const copyByLocale = {
  "zh-CN": {
    title: "切换账号？",
    description: "将退出当前手机网页端账号，返回登录页。电脑端仍保持登录。",
    cancel: "取消",
    confirm: "退出并切换",
  },
  "en-US": {
    title: "Switch account?",
    description:
      "You will sign out of this mobile web session and return to the sign-in page. Your computer will stay signed in.",
    cancel: "Cancel",
    confirm: "Sign out & switch",
  },
};

export function WebRemoteControlSwitchAccountDialog({
  children,
  locale,
  onConfirm,
}: {
  children: ReactElement;
  locale: WebRemoteControlScreenLocale;
  onConfirm(): void;
}) {
  const copy = copyByLocale[locale];
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent showCloseButton={false} className="gap-6 p-6 sm:max-w-sm">
        <DialogHeader className="gap-3">
          <DialogTitle className="text-ui-lg">{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-auto min-h-11 whitespace-normal"
            >
              {copy.cancel}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button
              type="button"
              size="lg"
              className="h-auto min-h-11 whitespace-normal"
              onClick={onConfirm}
            >
              {copy.confirm}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
