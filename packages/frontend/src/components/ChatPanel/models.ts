import type { LlmModel } from './ModelSelectorPrompt';

/**
 * Selectable chat models. This list is the built-in fallback used when the
 * backend catalog (GET /chat/models, backed by SSM) is unavailable. To
 * add/change a model without redeploying, edit the SSM parameter
 * `/idp-v2/chat/models` instead - the frontend loads it at runtime.
 *
 * The agent passes `model_id` straight through to Bedrock (the runtime IAM role
 * already allows bedrock:InvokeModel on all models), so a catalog entry only
 * needs a valid Bedrock model id in `value`. The first entry is the default.
 *
 * `metrics` (1-10) drive the preview card's bars; they are illustrative, not
 * measured. `contextWindow`/prices show in the Context/Cost tooltips.
 */
export type ChatModel = LlmModel;

export const CHAT_MODELS: ChatModel[] = [
  {
    value: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    label: 'Haiku 4.5',
    description: 'Fast, low-cost (demo default)',
    contextWindow: '200K tokens',
    inputPrice: '$1.00 / 1M',
    outputPrice: '$5.00 / 1M',
    metrics: { intelligence: 6, speed: 10, context: 7, cost: 10 },
    // Haiku 4.5 has no effort/reasoning control.
    supportsReasoning: false,
  },
  {
    value: 'global.anthropic.claude-sonnet-5',
    label: 'Sonnet 5',
    description: '일상 작업에 최적',
    contextWindow: '1M tokens',
    inputPrice: '$3.00 / 1M',
    outputPrice: '$15.00 / 1M',
    metrics: { intelligence: 8, speed: 8, context: 10, cost: 7 },
  },
  {
    value: 'global.anthropic.claude-opus-4-8',
    label: 'Opus 4.8',
    description: '복잡한 작업에 가장 강력',
    contextWindow: '1M tokens',
    inputPrice: '$5.00 / 1M',
    outputPrice: '$25.00 / 1M',
    metrics: { intelligence: 10, speed: 5, context: 10, cost: 5 },
  },
  {
    value: 'global.anthropic.claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: '안정적인 이전 세대 모델',
    contextWindow: '200K tokens',
    inputPrice: '$3.00 / 1M',
    outputPrice: '$15.00 / 1M',
    metrics: { intelligence: 7, speed: 8, context: 8, cost: 7 },
    // Sonnet 4.6 has no effort/reasoning control.
    supportsReasoning: false,
  },
];

export const DEFAULT_MODEL_ID = CHAT_MODELS[0].value;
