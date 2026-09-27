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
    value: 'global.amazon.nova-2-lite-v1:0',
    label: 'Nova 2 Lite',
    description: 'Amazon first-party model (credit-eligible)',
    contextWindow: '1M tokens',
    inputPrice: '$0.30 / 1M',
    outputPrice: '$2.50 / 1M',
    metrics: { intelligence: 6, speed: 9, context: 10, cost: 10 },
    // Nova does not accept the Anthropic output_config.effort field.
    supportsReasoning: false,
  },
];

export const DEFAULT_MODEL_ID = CHAT_MODELS[0].value;
