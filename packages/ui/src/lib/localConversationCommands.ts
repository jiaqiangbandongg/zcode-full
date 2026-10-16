type LocalConversationCommand = "new" | "clear";

const LOCAL_CONVERSATION_COMMAND_RE = /^\/(new|clear)\s*$/iu;

export function parseLocalConversationCommand(text: string): LocalConversationCommand | null {
  const matched = LOCAL_CONVERSATION_COMMAND_RE.exec(text.trim());
  if (!matched?.[1]) {
    return null;
  }

  return matched[1].toLowerCase() as LocalConversationCommand;
}
