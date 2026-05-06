import type { ModelCapability, UsageMetrics } from '@minicode/shared';

const CAPABILITY_COST: Record<ModelCapability, number> = {
  chat: 0.000003,
  reasoning: 0.000007,
  completion: 0.0000012,
  embedding: 0.0000004,
  fast: 0.000001
};

const history: UsageMetrics[] = [];

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function buildUsageMetrics(params: {
  startedAt: number;
  inputText: string;
  outputText: string;
  capability: ModelCapability;
  model: string;
  provider: string;
  promptVersion: string;
}): UsageMetrics {
  const estimatedInputTokens = estimateTokens(params.inputText);
  const estimatedOutputTokens = estimateTokens(params.outputText);
  const estimatedCostUsd = Number(((estimatedInputTokens + estimatedOutputTokens) * CAPABILITY_COST[params.capability]).toFixed(6));
  const metrics: UsageMetrics = {
    durationMs: Date.now() - params.startedAt,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    capability: params.capability,
    model: params.model,
    provider: params.provider,
    promptVersion: params.promptVersion
  };
  history.unshift(metrics);
  history.splice(20);
  return metrics;
}

export function getTelemetryHistory(): UsageMetrics[] {
  return history.slice();
}
