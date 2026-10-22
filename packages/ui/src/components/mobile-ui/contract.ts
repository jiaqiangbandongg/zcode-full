import type { ComponentProps } from "react";
import type { Dialog } from "radix-ui";

export interface DevicePlatformIconProps {
  platform?: string;
  className?: string;
}
export interface ZCodeAppLogoProps {
  className?: string;
}
export type BottomSheetProps = ComponentProps<typeof Dialog.Root>;
export type BottomSheetContentProps = ComponentProps<typeof Dialog.Content>;
