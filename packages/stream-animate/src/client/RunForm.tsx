import type { FormEvent } from "react";
import type { AppConfig } from "@/shared/types";
import type { RunFormState } from "@/client/api";

export function RunForm(props: {
  config: AppConfig | null;
  disabled: boolean;
  form: RunFormState;
  onChange: (form: RunFormState) => void;
  onSubmit: () => void;
}) {
  const update = <TKey extends keyof RunFormState>(key: TKey, value: RunFormState[TKey]) => {
    props.onChange({ ...props.form, [key]: value });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };

  return (
    <form className="panel runForm" onSubmit={submit}>
      <div className="panelHeader">
        <div>
          <h2>新建测速</h2>
          <p>{props.config?.hasEnvApiKey ? "可使用环境变量 API key" : "需要填写 API key"}</p>
        </div>
        <button className="primaryButton" disabled={props.disabled} type="submit">
          {props.disabled ? "运行中" : "开始"}
        </button>
      </div>

      <label>
        <span>API key</span>
        <input
          autoComplete="off"
          placeholder={props.config?.hasEnvApiKey ? "留空使用 DEEPSEEK_API_KEY" : "sk-..."}
          type="password"
          value={props.form.apiKey}
          onChange={(event) => update("apiKey", event.target.value)}
        />
      </label>

      <div className="fieldGrid">
        <label>
          <span>Model</span>
          <input value={props.form.model} onChange={(event) => update("model", event.target.value)} />
        </label>
        <label>
          <span>Base URL</span>
          <input
            value={props.form.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
          />
        </label>
      </div>

      <div className="fieldGrid compact">
        <label>
          <span>Reasoning</span>
          <select
            value={props.form.reasoningEffort}
            onChange={(event) =>
              update("reasoningEffort", event.target.value as RunFormState["reasoningEffort"])
            }
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <label>
          <span>Max tokens</span>
          <input
            min={16}
            type="number"
            value={props.form.maxTokens}
            onChange={(event) => update("maxTokens", Number(event.target.value))}
          />
        </label>
        <label>
          <span>Temperature</span>
          <input
            max={2}
            min={0}
            step={0.1}
            type="number"
            value={props.form.temperature}
            onChange={(event) => update("temperature", Number(event.target.value))}
          />
        </label>
      </div>

      <label className="checkboxRow">
        <input
          checked={props.form.thinkingEnabled}
          type="checkbox"
          onChange={(event) => update("thinkingEnabled", event.target.checked)}
        />
        <span>thinking enabled</span>
      </label>

      <label>
        <span>System</span>
        <textarea
          rows={2}
          value={props.form.systemPrompt}
          onChange={(event) => update("systemPrompt", event.target.value)}
        />
      </label>
      <label>
        <span>User</span>
        <textarea
          rows={4}
          value={props.form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
        />
      </label>
    </form>
  );
}
