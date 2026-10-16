import { AgentRuntime } from "../src/runtime.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";

type TestRuntimeConfig = Omit<AgentRuntimeConfig, "modelSelection"> &
  Partial<Pick<AgentRuntimeConfig, "modelSelection">> & {
    /** 测试模型的能力上限，不进入 Selection 或生产 Runtime Config。 */
    maxOutputTokens?: number;
  };
type TestRuntimeDeps = Omit<AgentRuntimeDeps, "modelFactory"> &
  Partial<Pick<AgentRuntimeDeps, "modelFactory">>;

/**
 * 低层 Runtime 测试也显式经过 ModelFactory/ModelSelection 契约。
 * 与具体模型无关的测试由该 fixture 注入不可联网的测试 Model，不在生产 Runtime 制造 sentinel。
 */
export function createTestAgentRuntime(
  sessionId: ConstructorParameters<typeof AgentRuntime>[0],
  config: TestRuntimeConfig,
  deps: TestRuntimeDeps,
): AgentRuntime {
  const { maxOutputTokens, ...runtimeConfig } = config;
  const modelSelection =
    runtimeConfig.modelSelection ?? createTestModelSelection("test/default-runtime-model");
  const modelAdapter = deps.modelAdapter;
  const baseModelFactory =
    deps.modelFactory ??
    (modelAdapter
      ? createTestModelFactory({
          generateText: (request) => modelAdapter.generateText(request as never),
          ...(modelAdapter.streamText
            ? { streamText: (request) => modelAdapter.streamText!(request as never) }
            : {}),
        })
      : createTestModelFactory({}));
  const modelFactory =
    maxOutputTokens === undefined
      ? baseModelFactory
      : (input: Parameters<typeof baseModelFactory>[0]) => {
          const wrap = (
            model: ReturnType<typeof baseModelFactory>,
          ): ReturnType<typeof baseModelFactory> =>
            Object.freeze({
              ...model,
              optionSpecs: Object.freeze({
                ...model.optionSpecs,
                maxOutputTokens: Object.freeze({ max: maxOutputTokens }),
              }),
              bind(options) {
                return wrap(model.bind(options));
              },
            });
          return wrap(baseModelFactory(input));
        };
  return new AgentRuntime(
    sessionId,
    { ...runtimeConfig, modelSelection },
    {
      ...deps,
      modelFactory,
    },
  );
}
