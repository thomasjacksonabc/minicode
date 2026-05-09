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

export interface EmbeddingRequest {
  model?: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  model: string;
  provider: string;
  vectors: number[][];
  dimensions: number;
}

export interface SearchResultItem {
  filePath: string;
  chunkId: string;
  score: number;
  excerpt: string;
  startLine: number;
  endLine: number;
}

export interface ProjectSearchRequest {
  cwd: string;
  query: string;
  limit?: number;
}

export interface ProjectSearchResponse {
  query: string;
  items: SearchResultItem[];
  index?: {
    workspaceHash: string;
    builtAt: string;
    totalFiles: number;
    totalChunks: number;
  };
  warnings?: string[];
}

export interface ProjectIndexBuildRequest {
  cwd: string;
  force?: boolean;
}

export interface ProjectIndexBuildResponse {
  ok: boolean;
  workspaceHash: string;
  builtAt?: string;
  totalFiles?: number;
  totalChunks?: number;
  reused?: boolean;
  warnings?: string[];
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
    retrieval?: {
      query?: string;
      maxResults?: number;
      results?: SearchResultItem[];
    };
  };
}

export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ToolObservation {
  toolCallId?: string;
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

export interface ResponseCacheMetadata {
  scope: 'chat' | 'completion';
  key: string;
  hit: boolean;
}

export interface StreamingMetadata {
  transport: 'sse';
  path?: string;
  firstEventLatencyMs?: number;
  completed?: boolean;
}

export interface ChatTurnResponse {
  sessionId: string;
  mode: AgentMode;
  message: string;
  toolCalls: ToolCall[];
  observations: ToolObservation[];
  retrieval?: {
    attempted: boolean;
    used: boolean;
    status: 'executed' | 'blocked';
    query?: string;
    results: SearchResultItem[];
    reason?: string;
  };
  continuation?: {
    pending: boolean;
    resumedFromToolCallId?: string;
  };
  cache?: ResponseCacheMetadata;
  streaming?: StreamingMetadata;
  summary?: string;
  metrics?: UsageMetrics;
}

export interface ToolApprovalRequest {
  sessionId: string;
  toolCallId: string;
  approved: boolean;
}

export interface ToolApprovalResponse {
  sessionId: string;
  toolCallId: string;
  approved: boolean;
  resumed: boolean;
  message?: string;
  response?: ChatTurnResponse;
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
  cache?: ResponseCacheMetadata;
  metrics?: UsageMetrics;
}

export interface ChatStreamStartEvent {
  type: 'start';
  sessionId: string;
  mode: AgentMode;
  promptVersion: string;
  cache?: ResponseCacheMetadata;
}

export interface ChatStreamDeltaEvent {
  type: 'message_delta';
  delta: string;
}

export interface ChatStreamFinalEvent {
  type: 'final';
  response: ChatTurnResponse;
}

export interface ChatStreamErrorEvent {
  type: 'error';
  message: string;
}

export interface ChatStreamDoneEvent {
  type: 'done';
}

export type ChatStreamEvent =
  | ChatStreamStartEvent
  | ChatStreamDeltaEvent
  | ChatStreamFinalEvent
  | ChatStreamErrorEvent
  | ChatStreamDoneEvent;

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
    directory?: string;
    fallback?: 'built-in' | 'error';
  };
  cache?: {
    enabled: boolean;
    maxEntries: number;
  };
  streaming?: {
    ssePath?: string;
  };
  indexing?: {
    enabled?: boolean;
    directory?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    maxResults?: number;
    exclude?: string[];
    includeExtensions?: string[];
  };
  execution?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    isolationMode?: 'process' | 'none';
  };
}
