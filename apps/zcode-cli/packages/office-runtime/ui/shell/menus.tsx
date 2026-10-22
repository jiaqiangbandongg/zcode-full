import type { DocKind } from "#office/contract.ts";
import type { Strings } from "#ui/i18n.ts";
import { FileType, Icon } from "#ui/icons.tsx";
import { baseName, dirName } from "#ui/rpc.ts";
import { Menu, MenuItem } from "#ui/shell/parts.tsx";
import type { FitMode } from "#ui/viewers/types.ts";

// 面板标题栏的两个下拉菜单（切换文档、更多操作），从 main.tsx 拆出以控制单文件规模，行为不变。

export function SwitchMenu({
  t,
  recent,
  currentPath,
  onOpen,
  onBrowse,
  onClose,
}: {
  t: Strings;
  recent: { path: string; kind: DocKind }[];
  currentPath: string | undefined;
  onOpen(path: string): void;
  onBrowse(): void;
  onClose(): void;
}) {
  return (
    <Menu className="switcher" label={t.switchDocument} onClose={onClose}>
      {recent.length ? <div className="mlabel">{t.recent}</div> : null}
      {recent.map((item) => (
        <MenuItem
          key={item.path}
          icon={<FileType kind={item.kind} />}
          hint={
            item.path === currentPath ? (
              <Icon name="check" size={16} />
            ) : (
              baseName(dirName(item.path))
            )
          }
          onSelect={() => (item.path === currentPath ? onClose() : onOpen(item.path))}
        >
          {baseName(item.path)}
        </MenuItem>
      ))}
      {recent.length ? <div className="msep" /> : null}
      <MenuItem icon={<Icon name="folder-open" size={16} />} onSelect={onBrowse}>
        {t.openFile}
      </MenuItem>
    </Menu>
  );
}

export function MoreMenu({
  t,
  zoomable,
  zoomMode,
  onFit,
  onFind,
  onReload,
  onClose,
}: {
  t: Strings;
  zoomable: boolean;
  zoomMode: FitMode | null | undefined;
  onFit(mode: FitMode): void;
  onFind(): void;
  onReload(): void;
  onClose(): void;
}) {
  return (
    <Menu className="more" label={t.more} onClose={onClose}>
      {zoomable ? (
        <>
          <MenuItem checked={zoomMode === "width"} onSelect={() => onFit("width")}>
            {t.fitWidth}
          </MenuItem>
          <MenuItem checked={zoomMode === "page"} onSelect={() => onFit("page")}>
            {t.fitPage}
          </MenuItem>
          <MenuItem checked={zoomMode === "actual"} hint="100%" onSelect={() => onFit("actual")}>
            {t.actualSize}
          </MenuItem>
          <div className="msep" />
        </>
      ) : null}
      <MenuItem icon={<Icon name="search" size={16} />} hint="⌘F" onSelect={onFind}>
        {t.find}
      </MenuItem>
      <MenuItem icon={<Icon name="rotate-cw" size={16} />} onSelect={onReload}>
        {t.reload}
      </MenuItem>
    </Menu>
  );
}
