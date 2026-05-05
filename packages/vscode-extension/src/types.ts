export type AgentMode = 'ask' | 'plan' | 'agent' | 'edit' | 'explore';

export interface AttachmentRef {
  kind: 'file' | 'folder' | 'selection' | 'diagnostic' | 'image' | 'url';
  label: string;
  value: string;
}

export interface ChatTurnRequest {
  mode: AgentMode;
  sessionId: string;
  prompt: string;
  cwd?: string;
  attachments: AttachmentRef[];
  context: {
    activeFile?: string;
    selection?: string;
    openEditors: string[];
    diagnostics: Array<{ file: string; message: string; severity: string }>;
    gitDiff?: string;
    projectIndexSummary?: string;
  };
}

export interface ToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ChatTurnResponse {
  sessionId: string;
  mode: AgentMode;
  message: string;
  toolCalls: ToolCall[];
  summary?: string;
}

export interface CompletionRequest {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  neighbors: Array<{ fileName: string; excerpt: string }>;
}

export interface CompletionResponse {
  items: Array<{
    text: string;
    detail: string;
  }>;
}

export type FeatureStatus = 'planned' | 'in_progress' | 'done' | 'blocked';
export type FeatureArea = 'extension' | 'sidecar' | 'shared' | 'infra' | 'docs';

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
