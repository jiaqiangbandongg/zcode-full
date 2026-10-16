import type { ComponentProps } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export function SettingsBackButton({
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      type="button"
      size="lg"
      variant="ghost"
      className={cn("-ml-2", className)}
      {...props}
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {children}
    </Button>
  );
}
