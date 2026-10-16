# 字号修复方案

## 映射规则

| 当前值 | 默认大小 | 目标值 | 默认大小 |
|--------|---------|--------|---------|
| `text-xs` | 12px | `text-ui-sm` | 12px |
| `text-sm` | 14px | `text-ui-base` | 14px |
| `text-[13px]` | 13px | `text-ui-base` | 14px |
| `text-[14px]` | 14px | `text-ui-base` | 14px |
| `text-[15px]` | 15px | `text-ui-base` | 14px |
| `text-[16px]` | 16px | `text-ui-lg` | 16px |
| `text-[28px]` | 28px | **不动** | 页面级 h1，与设置页标题同级 |

## 文件清单

### 1. `BrowserSettingsSection.tsx`

- L217: `text-sm font-medium text-foreground-subtle` → `text-ui-base font-medium text-foreground-subtle`
- L238: `text-sm text-destructive` → `text-ui-base text-destructive`
- L246: `text-sm font-medium text-foreground-subtle` → `text-ui-base font-medium text-foreground-subtle`
- L250: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L274: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`

### 2. `previewPaneContent.tsx`

- L239: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L249: `` `p-3 text-sm ${...}` `` → `` `p-3 text-ui-base ${...}` ``

### 3. `ChatMediaAttachmentPreviewDialog.tsx`

- L55: `text-sm text-destructive` → `text-ui-base text-destructive`
- L59: `text-sm text-muted-foreground` → `text-ui-base text-muted-foreground`

### 4. `pdf-viewer.tsx`

- L342: `text-sm text-destructive` → `text-ui-base text-destructive`
- L357: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L360: `text-sm text-destructive` → `text-ui-base text-destructive`
- L363: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L396: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L410: `text-sm text-foreground` → `text-ui-base text-foreground`
- L435: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`

### 5. `CodeCommentAttachmentChip.tsx`

- L54: `"text-sm font-medium text-foreground` → `"text-ui-base font-medium text-foreground`
- L97: `text-sm/relaxed text-foreground` → `text-ui-base/relaxed text-foreground`
- L105: `text-[13px] text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L109: `text-[13px] text-foreground-subtlest` → `text-ui-base text-foreground-subtlest`
- L113: `text-sm/relaxed text-foreground-subtle` → `text-ui-base/relaxed text-foreground-subtle`

### 6. `previewPanePdfContent.tsx`

- L21: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`

### 7. `WorkspaceSidebarFooterUsageSummary.tsx`

- L391: `text-xs font-medium leading-3` → `text-ui-sm font-medium leading-3`

### 8. `CodingPlanBillingDiscount.tsx`

- L147: `"gap-0.5 px-1.5 text-xs leading-3"` → `"gap-0.5 px-1.5 text-ui-sm leading-3"`

### 9. `RepoWikiPane.tsx`

- L1055: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L1710: `text-sm font-medium text-foreground-subtle` → `text-ui-base font-medium text-foreground-subtle`
- L1720: `text-sm leading-5 text-foreground-subtle` → `text-ui-base leading-5 text-foreground-subtle`

### 10. `WindowsChromeImportConsentDialog.tsx`

- L42: `text-sm text-foreground` → `text-ui-base text-foreground`

### 11. `node-repl.tsx`

- L139: `text-sm font-medium text-foreground-subtle` → `text-ui-base font-medium text-foreground-subtle`
- L206: `text-sm font-medium text-destructive` → `text-ui-base font-medium text-destructive`
- L207: `text-sm text-destructive` → `text-ui-base text-destructive`
- L223: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L231: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`

### 12. `BrowserViewportToolbar.tsx`

- L146: `text-sm font-medium tabular-nums` → `text-ui-base font-medium tabular-nums`
- L173: `text-sm text-foreground-subtle` → `text-ui-base text-foreground-subtle`
- L181: `text-sm font-medium tabular-nums` → `text-ui-base font-medium tabular-nums`

### 13. `BrowserViewportSurface.tsx`

- L51: `text-sm font-medium text-foreground` → `text-ui-base font-medium text-foreground`

### 14. `AutomationEditView.tsx`

- L1900: `text-[28px]` → **不动**
- L1906: `text-[16px]` → `text-ui-lg`
- L1951: `text-[14px]` → `text-ui-base`
- L1965: `text-[14px]` → `text-ui-base`
- L2029: `text-[14px]` → `text-ui-base`
- L2051: `text-[14px]` → `text-ui-base`
- L2055: `text-[14px]` → `text-ui-base`
- L2076: `text-[14px]` → `text-ui-base`
- L2093: `text-[14px]` → `text-ui-base`
- L2100: `text-[14px]` → `text-ui-base`
- L2103: `text-[14px]` → `text-ui-base`
- L2420: `text-[14px]` → `text-ui-base`
- L2438: `text-[14px]` → `text-ui-base`
- L2480: `text-[13px]` → `text-ui-base`
- L2629: `text-[13px]` → `text-ui-base`

### 15. `AutomationsSection.tsx`

- L598: `text-[28px]` → **不动**
- L601: `text-[14px]` → `text-ui-base`
- L616: `text-[14px]` → `text-ui-base`
- L702: `text-[14px]` → `text-ui-base`
- L785: `text-[14px]` → `text-ui-base`
- L805: `text-[14px]` → `text-ui-base`

### 16. `InstalledPluginManagement.tsx`

- L242: `text-[15px]` → `text-ui-base`

### 17. `TicketDetail.tsx`

- L198: `text-[15px]` → `text-ui-base`

### 18. `cron-create.tsx`

- L134: `text-[14px]` → `text-ui-base`
