import { createLucideIcon, Folder, FolderOpen, Folders, type LucideProps } from "lucide-react";

// 沿用 Folders 的后层轮廓，前层增加打开的折页，保持相同画布、线宽和主题颜色。
const FoldersOpen = createLucideIcon("folders-open", [
  [
    "path",
    {
      d: "m10 12 1.2-2a2 2 0 0 1 1.72-1H21a1 1 0 0 1 .97 1.25l-1.1 4.25A2 2 0 0 1 18.94 16H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6H20a2 2 0 0 1 2 2v2",
      key: "front",
    },
  ],
  ["path", { d: "M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1", key: "back" }],
]);

export function ProjectFolderIcon({
  rootCount,
  open = false,
  ...props
}: LucideProps & { rootCount: number; open?: boolean }) {
  const Icon = rootCount > 1 ? (open ? FoldersOpen : Folders) : open ? FolderOpen : Folder;
  return <Icon {...props} />;
}
