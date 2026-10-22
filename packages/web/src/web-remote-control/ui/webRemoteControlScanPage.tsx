import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";

export function WebRemoteControlScanPage({ locale }: { locale: "zh-CN" | "en-US" }) {
  const zh = locale === "zh-CN";
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-xl border border-card-border bg-card p-5 shadow-sm">
        <WebRemoteControlBrand className="mb-2" />
        <h1 className="text-ui-lg font-medium">
          {zh ? "请扫描桌面二维码" : "Scan the desktop QR code"}
        </h1>
        <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
          {zh
            ? "在电脑端打开 Web 远程控制，再用手机扫描二维码连接。"
            : "Open Web remote control on your computer, then scan its QR code to connect."}
        </p>
      </section>
    </main>
  );
}
