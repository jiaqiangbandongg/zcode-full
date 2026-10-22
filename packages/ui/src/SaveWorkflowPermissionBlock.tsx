import { ChevronRightIcon, Save } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { formatWorkflowArgValue } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readSaveWorkflowInput,
  SaveWorkflowOverwriteBadge,
  type WorkflowArgDeclaration,
} from "@/ToolCallBlocks/renderers/save-workflow.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_VALUE_PLACEHOLDER = "—";
// 实参表折叠时显示的行数：8 行在笔记本高度的窗口里还能让脚本开关留在第一屏。
const ARGS_PREVIEW_ROWS = 8;
// 与确认窗脚本开关同一副文字按钮样式：几个「展开」类开关在同一个窗里长得一样。
const DISCLOSURE_BUTTON_CLASS =
  "flex min-w-0 items-center gap-1 self-start rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle";

/**
 * 模型写的长文本：折叠时最多 4 行。开关只在文本**真的**被截断时出现——按字数或换行数去猜，
 * 窗口一宽就会出现点了什么也多不出来的空开关，所以量 scrollHeight 而不是猜。
 */
function ClampedText({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    // 展开态量不出「折叠时会不会被截断」，沿用折叠时的结论，开关才能停在「收起」上。
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span
        ref={textRef}
        className={cn(
          "min-w-0 max-w-full whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle",
          !expanded && "line-clamp-4",
        )}
      >
        {text}
      </span>
      {clipped ? (
        <button
          type="button"
          aria-expanded={expanded}
          className={DISCLOSURE_BUTTON_CLASS}
          data-workflow-save-clamp-toggle="true"
          onClick={() => setExpanded((value) => !value)}
        >
          {intl.formatMessage({
            id: expanded
              ? "chat.permission.workflow.save.showLess"
              : "chat.permission.workflow.save.showMore",
          })}
        </button>
      ) : null}
    </span>
  );
}

function MetadataRow({
  label,
  value,
  mono,
  clamp,
}: {
  label: string;
  value: string;
  mono?: boolean;
  clamp?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="shrink-0 text-ui-sm text-foreground-subtlest">{label}</span>
      {clamp === true ? (
        <ClampedText text={value} />
      ) : (
        <span
          className={cn(
            "min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle",
            mono === true && "font-mono [overflow-wrap:anywhere]",
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/**
 * args 声明表。列是 名称 / 类型 / 必填 / 默认值，说明另起一行跨列——五列在权限窗这个宽度上
 * 会把说明挤成一列碎字，而 DESIGN.md 明令不允许「靠紧凑截断才活得下去」的布局，也要求
 * 版面扛得住 i18n 膨胀。必填用文字而不是对勾：语义不靠图标单独表达。
 *
 * 表头 sticky：钉在确认窗唯一的滚动区顶部，行从它底下滚过去（表本身不滚）。屏幕够高时滚动区
 * 带 p-3，-top-3 抵掉它：粘性定位以内边距内沿为准，top-0 会在表头上方留出 12px 让行透出来；矮屏时
 * 滚动的是没有内边距的整窗，top-0 正好贴住上沿。border-separate
 * 让表头下边框跟着 th 一起钉住——border-collapse 下边框归表格所有，会随行滚走。名字与默认值
 * 任意处折行，表格不会被一个长值撑出横向滚动；类型列刻意不折——anywhere 会把列的最小宽度
 * 降到一个字符，自动表格布局随即把「string」挤成两行。
 */
function WorkflowArgsTable({ args }: { args: readonly WorkflowArgDeclaration[] }) {
  const { intl } = useZCodeIntl();

  const headers = [
    intl.formatMessage({ id: "chat.permission.workflow.save.args.name" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.type" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.required" }),
    intl.formatMessage({ id: "chat.permission.workflow.save.args.default" }),
  ];
  const requiredLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredYes",
  });
  const optionalLabel = intl.formatMessage({
    id: "chat.permission.workflow.save.args.requiredNo",
  });

  return (
    <table
      className="w-full border-separate border-spacing-0 text-left"
      data-workflow-save-args="true"
    >
      <thead>
        <tr>
          {headers.map((header) => (
            <th
              key={header}
              scope="col"
              className="sticky top-0 border-b border-border bg-popover pb-1 pr-3 text-ui-xs font-medium text-foreground-subtlest [@media(min-height:36rem)]:-top-3"
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {args.map((arg) => (
          <Fragment key={arg.name}>
            <tr data-workflow-save-arg={arg.name}>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtle [overflow-wrap:anywhere]">
                {arg.name}
              </td>
              <td className="pr-3 pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest">
                {arg.type ?? NO_VALUE_PLACEHOLDER}
              </td>
              <td className="pr-3 pt-1.5 align-top text-ui-sm text-foreground-subtlest">
                {arg.required ? requiredLabel : optionalLabel}
              </td>
              <td className="pt-1.5 align-top font-mono text-ui-sm text-foreground-subtlest [overflow-wrap:anywhere]">
                {arg.hasDefault ? formatWorkflowArgValue(arg.defaultValue) : NO_VALUE_PLACEHOLDER}
              </td>
            </tr>
            {arg.description === undefined ? null : (
              <tr>
                <td
                  colSpan={headers.length}
                  className="whitespace-pre-wrap break-words pb-1 pt-0.5 text-ui-sm text-foreground-subtlest"
                >
                  {arg.description}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * SaveWorkflow 的保存确认块。
 *
 * 这个 gate **没有 display 载荷**（spec 明确 v1 不加 `save_workflow` display kind）：入参就是
 * 全部内容，所以块里的每一项都读自归一化入参。脚本折叠沿用运行确认窗的同一习语与同一组文案
 * ——同一段脚本在两个窗里必须同名。
 *
 * 刻意**不**接 Refine：Refine 的语义是「拒绝这次运行并告诉模型怎么改工作流」，
 * 而保存是一次写盘，改法是模型换一组元数据重新调用，不需要第三个选项。
 *
 * 长内容（docs/dynamic-workflow/launch.md「`SaveWorkflow`」第 4 步）：说明、实参、脚本都是模型写的，
 * 长度没有上限。整个块放在 PermissionDialog 唯一的滚动区里，块内**不再有任何滚动容器**。
 * Bugfix：上一版给元数据框、实参表、脚本各自限高滚动，外面再套一层滚动段，一次滚轮手势会先被
 * 指针下的内框吃掉、到底后再交给外层，内框还比外层可视区高，读起来乱成一团。现在长的部分靠折叠
 * 变短（说明 4 行、实参 8 行、脚本默认收起），展开只是把同一个滚动区变长。
 */
export function SaveWorkflowPermissionBlock({ request }: { request: ZCodePermissionRequest }) {
  const { intl } = useZCodeIntl();

  const input = readSaveWorkflowInput(request.raw);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [allArgsShown, setAllArgsShown] = useState(false);

  // PermissionDialog 跨请求复用组件实例，换请求后必须回到默认折叠态，
  // 否则上一次的展开会泄漏到下一个保存确认。两段长文本的折叠态在 ClampedText 里，
  // 靠 key 带上 requestId 一起重置。
  useEffect(() => {
    setScriptOpen(false);
    setAllArgsShown(false);
  }, [request.requestId]);

  // 覆盖与新建是两句**不同的问句**，不是同一句话加个标记：用户要在读第一行时就知道
  // 这次操作会不会替换掉已经存在的东西。
  const title = intl.formatMessage({
    id: input.overwrite
      ? "chat.permission.workflow.save.overwriteTitle"
      : "chat.permission.workflow.save.title",
  });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const overwriteLabel = intl.formatMessage({ id: "chat.toolCall.workflow.save.overwrite" });
  const overwriteHint = intl.formatMessage({ id: "chat.permission.workflow.save.overwriteHint" });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });

  return (
    <div className="space-y-3" data-save-workflow-permission-block="true">
      <p className="text-ui-base font-medium leading-5 text-foreground">{title}</p>

      <div className="flex min-w-0 items-center gap-2">
        <Save className="size-4 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle">
          {input.name ?? fallbackName}
        </span>
        {input.overwrite ? <SaveWorkflowOverwriteBadge label={overwriteLabel} /> : null}
      </div>

      {input.overwrite ? (
        <p
          className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm text-foreground-subtle"
          data-workflow-overwrite-hint="true"
        >
          {overwriteHint}
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2">
        {input.path === undefined ? null : (
          <MetadataRow
            label={intl.formatMessage({ id: "chat.permission.workflow.save.path" })}
            value={input.path}
            mono
          />
        )}
        {input.description === undefined ? null : (
          <MetadataRow
            key={`${request.requestId}:description`}
            label={intl.formatMessage({ id: "chat.permission.workflow.save.description" })}
            value={input.description}
            clamp
          />
        )}
        {input.whenToUse === undefined ? null : (
          <MetadataRow
            key={`${request.requestId}:whenToUse`}
            label={intl.formatMessage({ id: "chat.permission.workflow.save.whenToUse" })}
            value={input.whenToUse}
            clamp
          />
        )}
      </div>

      {input.args.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <p className="text-ui-sm font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.permission.workflow.save.args" })}
          </p>
          <WorkflowArgsTable
            args={allArgsShown ? input.args : input.args.slice(0, ARGS_PREVIEW_ROWS)}
          />
          {input.args.length > ARGS_PREVIEW_ROWS ? (
            <button
              type="button"
              aria-expanded={allArgsShown}
              className={DISCLOSURE_BUTTON_CLASS}
              data-workflow-save-args-toggle="true"
              onClick={() => setAllArgsShown((value) => !value)}
            >
              {allArgsShown
                ? intl.formatMessage({ id: "chat.permission.workflow.save.args.showFewer" })
                : intl.formatMessage(
                    { id: "chat.permission.workflow.save.args.showAll" },
                    { count: input.args.length },
                  )}
            </button>
          ) : null}
        </div>
      )}

      {input.script === undefined ? null : (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <CodeBlock
              code={input.script}
              language="typescript"
              renderMermaid={false}
              showLineNumbers
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
