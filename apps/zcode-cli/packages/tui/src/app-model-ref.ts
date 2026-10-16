import type { TuiModelOption } from "./types.js";

const MODEL_REF_SEPARATOR = "/";
export const UNKNOWN_MODEL_FIELD = "-";

type ModelDisplayParts = {
  model: string;
  provider: string;
};

export function modelDisplayParts(modelSelection: string): ModelDisplayParts {
  const value = modelSelection.trim();
  if (!value) {
    return {
      model: UNKNOWN_MODEL_FIELD,
      provider: UNKNOWN_MODEL_FIELD,
    };
  }

  const separatorIndex = value.indexOf(MODEL_REF_SEPARATOR);
  if (separatorIndex <= 0) {
    return {
      model: value,
      provider: UNKNOWN_MODEL_FIELD,
    };
  }

  return {
    model: value.slice(separatorIndex + MODEL_REF_SEPARATOR.length).trim() || UNKNOWN_MODEL_FIELD,
    provider: value.slice(0, separatorIndex).trim() || UNKNOWN_MODEL_FIELD,
  };
}

/** Display only; model commands carry ref directly instead of parsing this value. */
export function modelOptionValue(model: TuiModelOption): string {
  return `${model.ref.providerId}/${model.ref.modelId}`;
}
