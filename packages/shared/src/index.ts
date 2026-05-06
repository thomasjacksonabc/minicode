export type AgentMode = 'ask' | 'plan' | 'agent' | 'edit' | 'explore';
export type ModelCapability = 'chat' | 'reasoning' | 'completion' | 'embedding' | 'fast';
export type ToolObservationStatus = 'executed' | 'approved' | 'denied' | 'blocked' | 'suggested';

export type FeatureStatus = 'planned' | 'in_progress' | 'done' | 'blocked';
export type FeatureArea = 'extension' | 'sidecar' | 'shared' | 'infra' | 'docs';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface AttachmentRef {
  kind: 'file' | 'folder' | 'selection' | 'diagnostic' | 'image' | 'url';
  label: string;
  value: string;
}

export interface EditorSnapshot {
  fileName: string;
  languageId?: string;
  excerpt: string;
}

export interface DependencyHint {
  name: string;
  version?: string;
  kind: 'dependency' | 'devDependency' | 'workspace';
}

export interface ChatTurnRequest {
  mode: AgentMode;
  sessionId: string;
  prompt: string;
  cwd?: string;
  promptVersion?: string;
  attachments: AttachmentRef[];
  modelPreferences?: Partial<Record<ModelCapability, string>>;
  context: {
    activeFile?: string;
    activeLanguageId?: string;
    selection?: string;
    openEditors: string[];
    visibleDocuments?: EditorSnapshot[];
    diagnostics: Array<{ file: string; message: string; severity: string }>;
    gitStatus?: string;
    gitDiff?: string;
    workspaceSummary?: string;
    dependencyHints?: DependencyHint[];
    relatedFiles?: string[];
    projectIndexSummary?: string;
  };
}

export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ToolObservation {
  tool: string;
  status: ToolObservationStatus;
  summary: string;
}

export interface UsageMetrics {
  durationMs: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  capability: ModelCapability;
  model: string;
  provider: string;
  promptVersion: string;
}

export interface ChatTurnResponse {
  sessionId: string;
  mode: AgentMode;
  message: string;
  toolCalls: ToolCall[];
  observations: ToolObservation[];
  summary?: string;
  metrics?: UsageMetrics;
}

export interface CompletionRequest {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  neighbors: EditorSnapshot[];
  workspaceSummary?: string;
  dependencyHints?: DependencyHint[];
}

export interface CompletionResponse {
  items: Array<{
    text: string;
    detail: string;
  }>;
  metrics?: UsageMetrics;
}

export interface FeatureRecord {
  id: string;
  title: string;
  area: FeatureArea;
  status: FeatureStatus;
  summary: string;
  dependsOn: string[];
  ownedBy: string[];
  paths: string[];
  acceptanceCriteria: string[];
  notes: string[];
  lastUpdated: string;
}

export interface FeaturesDocument {
  version: number;
  updatedAt: string;
  areas: Array<{ id: string; title: string }>;
  features: FeatureRecord[];
  milestones: Array<{ id: string; title: string; status: FeatureStatus; featureIds: string[] }>;
  rules: Record<string, unknown>;
}

export interface SidecarConfig {
  port: number;
  host: string;
  provider: {
    type: 'openai-compatible' | 'modelscope' | 'ollama' | 'mock';
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
  models: Record<ModelCapability, string>;
  tools: {
    allowedCommands: string[];
    autoApprove: boolean;
  };
  prompts: {
    version: string;
  };
}
