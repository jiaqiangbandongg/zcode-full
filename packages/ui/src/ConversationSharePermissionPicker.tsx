import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type ConversationSharePermission = "private" | "link-viewer" | "link-editor";

const PERMISSION_OPTIONS = [
  {
    value: "private",
    labelId: "conversationShare.permission.private",
  },
  {
    value: "link-viewer",
    labelId: "conversationShare.permission.linkViewer",
  },
  {
    value: "link-editor",
    labelId: "conversationShare.permission.linkEditor",
  },
] as const;

export function ConversationSharePermissionPicker({
  permission,
  onChange,
  disabled = false,
}: {
  permission: ConversationSharePermission;
  onChange: (permission: ConversationSharePermission) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="grid gap-1" data-testid="conversation-share-permission-picker">
      <span className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "conversationShare.permissionLabel" })}
      </span>
      <Select
        value={permission}
        onValueChange={(value) => onChange(value as ConversationSharePermission)}
        disabled={disabled}
      >
        <SelectTrigger
          size="lg"
          className="w-full"
          aria-label={intl.formatMessage({
            id: "conversationShare.permissionLabel",
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-conversation-share-keep-open="permission">
          {PERMISSION_OPTIONS.map(({ value, labelId }) => (
            <SelectItem key={value} value={value} data-conversation-share-permission={value}>
              {intl.formatMessage({ id: labelId })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
