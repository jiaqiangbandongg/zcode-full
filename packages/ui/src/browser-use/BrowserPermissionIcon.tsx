import {
  Bell,
  Camera,
  Clipboard,
  Folder,
  Keyboard,
  MapPin,
  Maximize,
  Mic,
  Monitor,
  MousePointer2,
  Music,
  Shield,
  Volume2,
} from "lucide-react";

/** 地址栏与面板复用同一能力字形；图标表示申请能力，不表示设备正在使用。 */
export function BrowserPermissionIcon({ capability }: { capability: string }) {
  const Icon =
    capability === "camera"
      ? Camera
      : capability === "microphone"
        ? Mic
        : capability === "geolocation"
          ? MapPin
          : capability === "notifications"
            ? Bell
            : capability.startsWith("clipboard-")
              ? Clipboard
              : capability === "display-capture" || capability === "window-management"
                ? Monitor
                : capability === "fullscreen"
                  ? Maximize
                  : capability === "keyboardLock"
                    ? Keyboard
                    : capability === "pointerLock"
                      ? MousePointer2
                      : capability === "midi" || capability === "midiSysex"
                        ? Music
                        : capability === "speaker-selection"
                          ? Volume2
                          : capability.startsWith('["fileSystem"')
                            ? Folder
                            : Shield;
  return <Icon className="size-4 shrink-0" />;
}
