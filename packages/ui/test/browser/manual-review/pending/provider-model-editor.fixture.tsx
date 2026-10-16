import { useState } from "react";
import type { ProviderModelDraftCommitResult } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { smartDraftModel } from "../../../providerModelSmartDraftFixture.js";

export function ProviderModelEditorFixture() {
  const editMode = new URLSearchParams(location.search).has("edit");
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<
    Extract<ProviderModelDraftCommitResult, { status: "invalid" }>["field"] | null
  >(null);
  const [model] = useState(() => {
    const initial = smartDraftModel();
    if (new URLSearchParams(location.search).has("emptyReasoning")) {
      initial.config.optionSpecs!.reasoningLevel!.values = [];
    }
    return initial;
  });
  const [scope, setScope] = useState("fixture");
  const editor = useProviderModelDraft({
    model,
    open,
    scopeKey: scope,
    resolve: async (id) => {
      const response = await fetch(`/resolve?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error("recommendation failed");
      return response.json();
    },
  });
  return (
    <>
      <button data-testid="external-scope" onClick={() => setScope((value) => value + "-other")}>
        Switch scope
      </button>
      <button
        onClick={() => {
          editor.reset(model);
          setError(null);
          setErrorField(null);
          setOpen(true);
        }}
      >
        Reopen editor
      </button>
      <output data-testid="editor-draft">{JSON.stringify(editor.draft)}</output>
      <ProviderModelMetadataDialog
        mode={editMode ? "edit" : "add"}
        modelIdReadOnly={editMode}
        open={open}
        draft={editor.draft}
        draftErrorMessage={error}
        draftErrorField={errorField}
        inheritedConfig={editor.inheritedConfig}
        overrideFields={editor.overrides}
        onOpenChange={setOpen}
        onDraftChange={(patch) => {
          editor.change(patch);
          setError(null);
          setErrorField(null);
        }}
        onRestore={() => void editor.restore().catch((caught) => setError(String(caught)))}
        saving={saving}
        modelConfigResolutionPending={editor.pending}
        onModelIdBlur={() => void editor.flush().catch(() => undefined)}
        onCommit={async () => {
          setSaving(true);
          try {
            const result = await editor.commit();
            if (result.status !== "commit") {
              setError(result.field);
              setErrorField(result.field);
              return false;
            }
            const response = await fetch("/mutation", {
              method: "POST",
              body: JSON.stringify(result.model),
            });
            if (!response.ok) throw new Error("save failed");
            setOpen(false);
            return true;
          } catch (caught) {
            setError(String(caught));
            return false;
          } finally {
            setSaving(false);
          }
        }}
      />
    </>
  );
}
