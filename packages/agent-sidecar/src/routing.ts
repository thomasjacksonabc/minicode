import type { AgentMode, ChatTurnRequest, ModelCapability, SidecarConfig } from '@minicode/shared';

export interface ResolvedRoute {
  capability: ModelCapability;
  model: string;
  provider: SidecarConfig['provider']['type'];
  promptVersion: string;
  temperature: number;
  maxTokens: number;
}

function capabilityForMode(mode: AgentMode, prompt: string): ModelCapability {
  if (mode === 'plan') {
    return 'reasoning';
  }
  if (mode === 'edit' || /refactor|debug|design|analy[sz]e|root cause/i.test(prompt)) {
    return 'reasoning';
  }
  if (mode === 'explore') {
    return 'embedding';
  }
  if (mode === 'ask') {
    return 'chat';
  }
  return 'fast';
}

export function resolveRoute(request: Pick<ChatTurnRequest, 'mode' | 'prompt' | 'modelPreferences' | 'promptVersion'>, config: SidecarConfig): ResolvedRoute {
  const capability = capabilityForMode(request.mode, request.prompt);
  const model = request.modelPreferences?.[capability] || config.models[capability] || config.provider.model;
  const temperature = capability === 'completion' || capability === 'fast' ? 0.2 : 0.4;
  const maxTokens = capability === 'reasoning' ? 1400 : capability === 'completion' ? 240 : 900;
  return {
    capability,
    model,
    provider: config.provider.type,
    promptVersion: request.promptVersion || config.prompts.version,
    temperature,
    maxTokens
  };
}
