import { useCallback, useEffect, useState } from "react";
import {
  clearConversationSelectionReferenceLimitReason,
  getConversationSelectionReferenceScope,
  getConversationSelectionReferenceLimitReason,
  getConversationSelectionAddEventName,
  isConversationSelectionAddEvent,
  setConversationSelectionReferenceScope,
  type ConversationSelectionLimitReason,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export function useConversationSelectionReferences(options: {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
}) {
  const [references, setReferencesState] = useState<readonly ConversationSelectionReference[]>(() =>
    getConversationSelectionReferenceScope(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );
  const [limitReason, setLimitReason] = useState<ConversationSelectionLimitReason | null>(() =>
    getConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );

  useEffect(() => {
    setReferencesState(
      getConversationSelectionReferenceScope(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
    setLimitReason(
      getConversationSelectionReferenceLimitReason(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  const setReferences = useCallback(
    (
      update:
        | readonly ConversationSelectionReference[]
        | ((
            current: readonly ConversationSelectionReference[],
          ) => readonly ConversationSelectionReference[]),
    ) => {
      setReferencesState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        setConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          next,
          options.draftScopeKey,
        );
        return next;
      });
    },
    [options.sessionId, options.workspaceKey, options.draftScopeKey],
  );

  useEffect(() => {
    const handleAdd = (event: Event) => {
      if (!isConversationSelectionAddEvent(event)) return;
      if (
        event.detail.targetSessionId !== options.sessionId ||
        event.detail.workspaceKey !== options.workspaceKey ||
        (options.sessionId === null && event.detail.draftScopeKey !== options.draftScopeKey)
      ) {
        return;
      }
      setReferencesState(
        getConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
      setLimitReason(
        getConversationSelectionReferenceLimitReason(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
    };
    window.addEventListener(getConversationSelectionAddEventName(), handleAdd);
    return () => window.removeEventListener(getConversationSelectionAddEventName(), handleAdd);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  const removeReference = useCallback(
    (id: string) => {
      setReferences((current) => current.filter((reference) => reference.id !== id));
      setLimitReason(null);
    },
    [setReferences],
  );
  const clearReferences = useCallback(() => {
    setReferences([]);
    setLimitReason(null);
  }, [setReferences]);
  const dismissLimitReason = useCallback(() => {
    clearConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    );
    setLimitReason(null);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  return {
    references,
    limitReason,
    dismissLimitReason,
    removeReference,
    clearReferences,
  };
}
