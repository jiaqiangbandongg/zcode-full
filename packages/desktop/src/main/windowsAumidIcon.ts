import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { ApplicationIconInfo } from "@zcode/shared";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

const SAFE_AUMID = /^[^\\/\s!]+![^\\/\s!]+$/u;
const MAX_ICON_BASE64_CHARS = 1024 * 1024;

// 不能把 AUMID 当文件路径交给 app.getFileIcon。AppsFolder 是 Shell namespace，
// 必须先由 SHCreateItemInKnownFolder 得到 IShellItem，再提取其真实应用图标。
const WINDOWS_AUMID_ICON_SCRIPT = String.raw`
Add-Type -AssemblyName System.Drawing;
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class ZCodeAumidIcon {
  [StructLayout(LayoutKind.Sequential)]
  private struct SIZE { public int cx; public int cy; }

  [ComImport]
  [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage(SIZE size, uint flags, out IntPtr bitmap);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHCreateItemInKnownFolder(
    ref Guid folderId,
    uint flags,
    string item,
    ref Guid interfaceId,
    out IShellItemImageFactory shellItem);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr value);

  public static byte[] Read(string aumid) {
    Guid appsFolder = new Guid("1e87508d-89c2-42f0-8a7e-645a0f50ca58");
    Guid imageFactory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory shellItem;
    int created = SHCreateItemInKnownFolder(
      ref appsFolder, 0, aumid, ref imageFactory, out shellItem);
    if (created != 0 || shellItem == null) Marshal.ThrowExceptionForHR(created);
    IntPtr bitmap = IntPtr.Zero;
    try {
      // SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY，避免退化成宿主 exe 缩略图。
      int loaded = shellItem.GetImage(new SIZE { cx = 64, cy = 64 }, 0x5, out bitmap);
      if (loaded != 0 || bitmap == IntPtr.Zero) Marshal.ThrowExceptionForHR(loaded);
      using (Bitmap image = Image.FromHbitmap(bitmap))
      using (MemoryStream output = new MemoryStream()) {
        image.Save(output, ImageFormat.Png);
        return output.ToArray();
      }
    } finally {
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      Marshal.ReleaseComObject(shellItem);
    }
  }
}
'@;
$zcodeIconBytes=[ZCodeAumidIcon]::Read($zcodeArg0);
[Console]::Out.Write([Convert]::ToBase64String($zcodeIconBytes));
`;

interface WindowsAumidIconDependencies {
  execute(command: string, args: readonly string[], timeoutMs: number): Promise<string>;
  systemRoot: string;
}

const defaultDependencies: WindowsAumidIconDependencies = {
  execute: (command, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
  systemRoot: process.env.SystemRoot ?? "C:\\Windows",
};

export function createWindowsAumidIconReader(
  dependencies: WindowsAumidIconDependencies = defaultDependencies,
) {
  return async (aumid: string): Promise<ApplicationIconInfo | null> => {
    const normalized = aumid.trim();
    if (!SAFE_AUMID.test(normalized)) return null;
    const powershell = win32.join(
      dependencies.systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = (
      await dependencies.execute(
        powershell,
        createEncodedPowerShellArgs(WINDOWS_AUMID_ICON_SCRIPT, [normalized]),
        5_000,
      )
    ).trim();
    if (
      !encoded ||
      encoded.length > MAX_ICON_BASE64_CHARS ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
    ) {
      return null;
    }
    return { iconDataUrl: `data:image/png;base64,${encoded}` };
  };
}

export const readWindowsAumidIcon = createWindowsAumidIconReader();
