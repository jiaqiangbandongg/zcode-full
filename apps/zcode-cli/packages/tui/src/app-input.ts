import type { ModelSelection } from "@zcode/shared";
import { modelOptionValue } from "./app-model-ref.js";
import type {
  DraftAttachment,
  EffortCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import { clampIndex } from "./app-selection-keyboard.js";
import { matchesText } from "./state.js";
import type {
  TuiClipboardImage,
  TuiEffortOption,
  TuiModelOption,
  TuiPromptAttachment,
  TuiPromptInput,
} from "./types.js";

const MODEL_COMMAND_NAME = "/model";
const MODEL_COMMAND_WITH_SPACE = `${MODEL_COMMAND_NAME} `;
const EFFORT_COMMAND_NAMES = ["/effort", "/variant"] as const;

export {
  clampIndex,
  filterSelectionItems,
  handleSelectionKey,
  printableKey,
} from "./app-selection-keyboard.js";

export function filterSlashCommands(
  draft: string,
  commands: readonly SlashCommand[],
): readonly SlashCommand[] {
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const query = draft.slice(1).toLowerCase();
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(query) ||
      command.aliases?.some((alias) => alias.toLowerCase().includes(query)),
  );
}

export function reconcileSlashSelection(
  draft: string,
  commands: readonly SlashCommand[],
): SlashSelectionState | undefined {
  return filterSlashCommands(draft, commands).length > 0 ? { selectedIndex: 0 } : undefined;
}

export function selectedSlashCommand(
  submittedValue: string,
  slashSelection: SlashSelectionState | undefined,
  commands: readonly SlashCommand[],
): SlashCommand | undefined {
  if (!slashSelection || !submittedValue.startsWith("/") || commands.length === 0) return undefined;
  return commands[clampIndex(slashSelection.selectedIndex, commands.length)];
}

export function visibleSlashCommandWindow(
  commands: readonly SlashCommand[],
  selectedIndex: number,
  maxVisible: number,
): {
  commands: readonly SlashCommand[];
  selectedIndex: number;
  startIndex: number;
} {
  if (commands.length === 0 || maxVisible <= 0) {
    return {
      commands: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, commands.length);
  const visibleCount = Math.min(maxVisible, commands.length);
  const maxStartIndex = commands.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    commands: commands.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

export function modelCommandQuery(draft: string): string | undefined {
  if (draft.trim() === "/model list") return undefined;
  if (draft === MODEL_COMMAND_NAME) return "";
  if (draft.startsWith(MODEL_COMMAND_WITH_SPACE)) {
    return draft.slice(MODEL_COMMAND_WITH_SPACE.length);
  }
  if (draft.startsWith(MODEL_COMMAND_NAME) && !/\s/u.test(draft)) {
    return draft.slice(MODEL_COMMAND_NAME.length);
  }
  return undefined;
}

export function filterModelOptions(
  draft: string,
  models: readonly TuiModelOption[],
): readonly TuiModelOption[] {
  const query = modelCommandQuery(draft);
  if (query === undefined) return [];
  return models.filter((model) =>
    matchesText(query, [
      modelOptionValue(model),
      model.label,
      model.providerLabel,
      `${MODEL_COMMAND_WITH_SPACE}${modelOptionValue(model)}`,
    ]),
  );
}

export function reconcileModelCommandSelection(
  draft: string,
  models: readonly TuiModelOption[],
): ModelCommandSelectionState | undefined {
  return modelCommandQuery(draft) !== undefined && models.length > 0
    ? { selectedIndex: 0 }
    : undefined;
}

export function selectedModelOption(
  submittedValue: string,
  modelSelection: ModelCommandSelectionState | undefined,
  models: readonly TuiModelOption[],
): TuiModelOption | undefined {
  if (!modelSelection || modelCommandQuery(submittedValue) === undefined || models.length === 0) {
    return undefined;
  }
  return models[clampIndex(modelSelection.selectedIndex, models.length)];
}

export function visibleModelOptionWindow(
  models: readonly TuiModelOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  models: readonly TuiModelOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (models.length === 0 || maxVisible <= 0) {
    return {
      models: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, models.length);
  const visibleCount = Math.min(maxVisible, models.length);
  const maxStartIndex = models.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    models: models.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

export function effortCommandQuery(draft: string): string | undefined {
  for (const commandName of EFFORT_COMMAND_NAMES) {
    const commandWithSpace = `${commandName} `;
    if (draft === commandName) return "";
    if (draft.startsWith(commandWithSpace)) {
      return draft.slice(commandWithSpace.length);
    }
    if (draft.startsWith(commandName) && !/\s/u.test(draft)) {
      return draft.slice(commandName.length);
    }
  }
  return undefined;
}

export function filterEffortOptions(
  draft: string,
  efforts: readonly TuiEffortOption[],
): readonly TuiEffortOption[] {
  const query = effortCommandQuery(draft);
  if (query === undefined) return [];
  return efforts.filter((effort) =>
    matchesText(query, [
      effort.id,
      effort.label,
      effort.description,
      `/effort ${effort.id}`,
      `/variant ${effort.id}`,
    ]),
  );
}

export function reconcileEffortCommandSelection(
  draft: string,
  efforts: readonly TuiEffortOption[],
): EffortCommandSelectionState | undefined {
  return effortCommandQuery(draft) !== undefined && efforts.length > 0
    ? { selectedIndex: 0 }
    : undefined;
}

export function selectedEffortOption(
  submittedValue: string,
  effortSelection: EffortCommandSelectionState | undefined,
  efforts: readonly TuiEffortOption[],
): TuiEffortOption | undefined {
  if (
    !effortSelection ||
    effortCommandQuery(submittedValue) === undefined ||
    efforts.length === 0
  ) {
    return undefined;
  }
  return efforts[clampIndex(effortSelection.selectedIndex, efforts.length)];
}

export function visibleEffortOptionWindow(
  efforts: readonly TuiEffortOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  efforts: readonly TuiEffortOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (efforts.length === 0 || maxVisible <= 0) {
    return {
      efforts: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, efforts.length);
  const visibleCount = Math.min(maxVisible, efforts.length);
  const maxStartIndex = efforts.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    efforts: efforts.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

export function isValidClipboardImage(image: TuiClipboardImage): boolean {
  const prefix = `data:${image.mediaType};base64,`;
  return image.dataUrl.startsWith(prefix) && image.dataUrl.length > prefix.length;
}

export function toPromptInput(
  text: string,
  attachments: DraftAttachment[],
  modelSelection?: ModelSelection,
): TuiPromptInput {
  const activeAttachments: TuiPromptAttachment[] = attachments
    .filter((attachment) => text.includes(attachment.placeholder))
    .map((attachment) =>
      attachment.type === "image"
        ? {
            content: attachment.dataUrl,
            path: attachment.placeholder,
            type: attachment.type,
          }
        : {
            path: attachment.path,
            type: attachment.type,
          },
    );

  return activeAttachments.length === 0 && !modelSelection
    ? text
    : {
        attachments: activeAttachments,
        text,
        ...(modelSelection ? { modelSelection } : {}),
      };
}

export function toDraftAttachments(
  attachments: readonly TuiPromptAttachment[] | undefined,
  allocateId: () => number,
): DraftAttachment[] {
  return (attachments ?? []).flatMap((attachment): DraftAttachment[] => {
    if (attachment.type === "file" && attachment.path) {
      const placeholder = `@${attachment.path}`;
      return [
        {
          id: allocateId(),
          path: attachment.path,
          placeholder,
          type: "file" as const,
        },
      ];
    }
    if (attachment.type !== "image" || !attachment.content) return [];
    const mediaType = imageMediaTypeFromDataUrl(attachment.content);
    if (!mediaType) return [];
    const placeholder = attachment.path ?? `[image #${allocateId()}]`;
    const id = imagePlaceholderId(placeholder) ?? allocateId();
    return [
      {
        dataUrl: attachment.content,
        id,
        mediaType,
        placeholder,
        type: "image" as const,
      },
    ];
  });
}

function imageMediaTypeFromDataUrl(dataUrl: string): TuiClipboardImage["mediaType"] | undefined {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() as TuiClipboardImage["mediaType"] | undefined;
}

function imagePlaceholderId(placeholder: string): number | undefined {
  const match = /^\[image #(\d+)\]$/i.exec(placeholder);
  if (!match?.[1]) return undefined;
  const id = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
