import { useState, type ComponentProps } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 显隐只属于字段草稿，不复制凭据值，也不触发表单提交。 */
export function RemotePasswordInput({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);
  const { intl } = useZCodeIntl();
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} className={cn(className, "pr-10")} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-1 top-1/2 -translate-y-1/2"
        aria-label={intl.formatMessage({ id: visible ? "ssh.hidePassword" : "ssh.showPassword" })}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </Button>
    </div>
  );
}
