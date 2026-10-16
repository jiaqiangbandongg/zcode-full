import type { ZCodeSlashCommand } from "@zcode/shared";

const WHITESPACE_RE = /\s/;

function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery.length === 0) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

export function extractActiveSlashQuery(textBeforeCursor: string): string | null {
  const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
  const lineText = textBeforeCursor.slice(lineStart);

  if (!lineText.startsWith("/")) {
    return null;
  }

  const query = lineText.slice(1);
  if (WHITESPACE_RE.test(query)) {
    return null;
  }

  return query;
}

export function filterSlashCommands(
  commands: ZCodeSlashCommand[],
  query: string | null,
): ZCodeSlashCommand[] {
  if (query === null) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return commands;
  }

  return commands
    .map((command) => {
      const nameScore = scoreFuzzyMatch(command.name, normalizedQuery);
      const descriptionScore = scoreFuzzyMatch(command.description, normalizedQuery);
      const hintScore = scoreFuzzyMatch(command.inputHint ?? "", normalizedQuery);
      const bestScore = Math.min(
        nameScore ?? Number.POSITIVE_INFINITY,
        descriptionScore !== null ? descriptionScore + 300 : Number.POSITIVE_INFINITY,
        hintScore !== null ? hintScore + 500 : Number.POSITIVE_INFINITY,
      );

      if (!Number.isFinite(bestScore)) {
        return null;
      }

      return { command, score: bestScore };
    })
    .filter((item): item is { command: ZCodeSlashCommand; score: number } => item !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.command.name.length !== right.command.name.length) {
        return left.command.name.length - right.command.name.length;
      }

      return left.command.name.localeCompare(right.command.name);
    })
    .map((item) => item.command);
}

interface SlashCommandReplacement {
  cursorOffset: number;
  text: string;
}

export function replaceActiveSlashCommand(
  textBeforeCursor: string,
  textAfterCursor: string,
  commandName: string,
): SlashCommandReplacement | null {
  const query = extractActiveSlashQuery(textBeforeCursor);
  if (query === null) {
    return null;
  }

  const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
  const suffixBoundary = textAfterCursor.search(WHITESPACE_RE);
  const trailingText = suffixBoundary === -1 ? "" : textAfterCursor.slice(suffixBoundary);
  const text = `${textBeforeCursor.slice(0, lineStart)}/${commandName} ${trailingText}`;
  const cursorOffset = lineStart + commandName.length + 2;

  return {
    cursorOffset,
    text,
  };
}
