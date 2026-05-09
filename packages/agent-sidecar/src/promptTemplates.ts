import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import type { ChatTurnRequest, CompletionRequest, ModelCapability, SearchResultItem, SidecarConfig, ToolObservation } from '@minicode/shared';
import type { ResolvedRoute } from './routing.js';

export type PromptScenario = 'chat' | 'completion';

interface PromptTemplateDocument {
  name: string;
  version: string;
  scenario: PromptScenario;
  capabilities?: ModelCapability[];
  variables?: string[];
  messages?: {
    system: string;
    user: string;
  };
  body?: string;
}

interface LoadedPromptTemplate {
  template: PromptTemplateDocument;
  warnings: string[];
}

interface CachedPromptTemplate {
  path: string;
  mtimeMs: number;
  template: PromptTemplateDocument;
}

export interface RenderedChatPrompt {
  system: string;
  user: string;
  templateName: string;
  templateVersion: string;
  warnings: string[];
}

export interface RenderedCompletionPrompt {
  prompt: string;
  templateName: string;
  templateVersion: string;
  warnings: string[];
}

function listBlock(title: string, items: string[]): string {
  if (items.length === 0) {
    return `${title}: none`;
  }
  return `${title}:\n- ${items.join('\n- ')}`;
}

function observationsBlock(observations: ToolObservation[]): string {
  if (observations.length === 0) {
    return 'Tool observations: none';
  }
  return `Tool observations:\n${observations.map((item) => `- [${item.status}] ${item.tool}: ${item.summary}`).join('\n')}`;
}

function retrievalBlock(query: string | undefined, results: SearchResultItem[]): { retrievalQuery: string; retrievalResults: string } {
  const retrievalQuery = query ? `Retrieval query:\n${query}` : 'Retrieval query: none';
  if (results.length === 0) {
    return {
      retrievalQuery,
      retrievalResults: 'Retrieval results: none'
    };
  }
  return {
    retrievalQuery,
    retrievalResults: `Retrieval results:\n${results
      .map(
        (item, index) =>
          `${index + 1}. ${item.filePath}:${item.startLine}-${item.endLine} (score ${item.score.toFixed(3)})\n${item.excerpt}`
      )
      .join('\n\n')}`
  };
}

function templateDirFromConfig(prompts: SidecarConfig['prompts']): string {
  if (prompts.directory) {
    return resolve(prompts.directory);
  }
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, '../prompts');
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Prompt template field "${field}" must be a non-empty string.`);
  }
  return value;
}

function parseTemplateDocument(source: unknown, filePath: string, scenario: PromptScenario): PromptTemplateDocument {
  if (!source || typeof source !== 'object') {
    throw new Error(`Prompt template ${filePath} must parse to an object.`);
  }

  const doc = source as Record<string, unknown>;
  const parsedScenario = ensureString(doc.scenario, 'scenario') as PromptScenario;
  if (parsedScenario !== scenario) {
    throw new Error(`Prompt template ${filePath} declared scenario "${parsedScenario}" but "${scenario}" was requested.`);
  }

  const capabilities = Array.isArray(doc.capabilities)
    ? doc.capabilities.filter((item): item is ModelCapability => typeof item === 'string') as ModelCapability[]
    : undefined;
  const variables = Array.isArray(doc.variables) ? doc.variables.filter((item): item is string => typeof item === 'string') : undefined;

  const messages =
    doc.messages && typeof doc.messages === 'object'
      ? {
          system: ensureString((doc.messages as Record<string, unknown>).system, 'messages.system'),
          user: ensureString((doc.messages as Record<string, unknown>).user, 'messages.user')
        }
      : undefined;

  const body = typeof doc.body === 'string' ? doc.body : undefined;
  if (scenario === 'chat' && !messages) {
    throw new Error(`Chat prompt template ${filePath} must define messages.system and messages.user.`);
  }
  if (scenario === 'completion' && !body) {
    throw new Error(`Completion prompt template ${filePath} must define body.`);
  }

  return {
    name: ensureString(doc.name, 'name'),
    version: ensureString(doc.version, 'version'),
    scenario,
    capabilities,
    variables,
    messages,
    body
  };
}

function interpolateTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => values[key] ?? '');
}

function builtInTemplate(scenario: PromptScenario): PromptTemplateDocument {
  if (scenario === 'chat') {
    return {
      name: 'chat-default',
      version: 'v2',
      scenario: 'chat',
      capabilities: ['chat', 'reasoning', 'fast'],
      variables: ['mode', 'promptVersion', 'capability', 'executionPolicy', 'safetyWarnings', 'userPrompt', 'openEditors', 'relatedFiles', 'dependencyHints', 'selection', 'projectIndexSummary', 'workspaceSummary', 'gitStatus', 'gitDiff', 'diagnostics', 'visibleDocuments', 'retrievalQuery', 'retrievalResults', 'observations'],
      messages: {
        system: [
          'You are MiniCode, an AI coding assistant operating in {{mode}} mode.',
          'Prompt template version: {{promptVersion}}.',
          'Selected capability: {{capability}}.',
          '{{executionPolicy}}',
          'Respect project architecture, existing conventions, and user-provided constraints.',
          '{{safetyWarnings}}'
        ].join('\n'),
        user: [
          'User prompt:',
          '{{userPrompt}}',
          '',
          '{{openEditors}}',
          '',
          '{{relatedFiles}}',
          '',
          '{{dependencyHints}}',
          '',
          '{{selection}}',
          '',
          '{{projectIndexSummary}}',
          '',
          '{{workspaceSummary}}',
          '',
          '{{gitStatus}}',
          '',
          '{{gitDiff}}',
          '',
          '{{diagnostics}}',
          '',
          '{{visibleDocuments}}',
          '',
          '{{retrievalQuery}}',
          '',
          '{{retrievalResults}}',
          '',
          '{{observations}}'
        ].join('\n')
      }
    };
  }

  return {
    name: 'completion-default',
    version: 'v2',
    scenario: 'completion',
    capabilities: ['completion'],
    variables: ['workspaceSummary', 'dependencyHints', 'fileName', 'languageId', 'prefix', 'suffix', 'neighborFiles'],
    body: [
      'Complete the code at the cursor for {{fileName}} ({{languageId}}).',
      'Return code only, with no markdown fences or explanation.',
      '',
      '{{workspaceSummary}}',
      '',
      '{{dependencyHints}}',
      '',
      'Prefix:',
      '{{prefix}}',
      '',
      'Suffix:',
      '{{suffix}}',
      '',
      '{{neighborFiles}}'
    ].join('\n')
  };
}

export class PromptTemplateStore {
  private readonly cache = new Map<PromptScenario, CachedPromptTemplate>();
  private readonly directory: string;
  private readonly fallback: 'built-in' | 'error';

  constructor(prompts: SidecarConfig['prompts']) {
    this.directory = templateDirFromConfig(prompts);
    this.fallback = prompts.fallback || 'built-in';
  }

  private templatePath(scenario: PromptScenario): string {
    return resolve(this.directory, `${scenario}.yaml`);
  }

  loadTemplate(scenario: PromptScenario, requestedVersion?: string, capability?: ModelCapability): LoadedPromptTemplate {
    const warnings: string[] = [];
    const builtIn = builtInTemplate(scenario);

    try {
      const filePath = this.templatePath(scenario);
      const fileStats = statSync(filePath);
      const cached = this.cache.get(scenario);
      if (cached && cached.path === filePath && cached.mtimeMs === fileStats.mtimeMs) {
        return this.validateTemplateSelection(cached.template, scenario, requestedVersion, capability, warnings, builtIn);
      }

      const parsed = parseTemplateDocument(parseYaml(readFileSync(filePath, 'utf8')), filePath, scenario);
      this.cache.set(scenario, {
        path: filePath,
        mtimeMs: fileStats.mtimeMs,
        template: parsed
      });
      return this.validateTemplateSelection(parsed, scenario, requestedVersion, capability, warnings, builtIn);
    } catch (error) {
      if (this.fallback === 'error') {
        throw error;
      }
      warnings.push(`Fell back to built-in ${scenario} prompt template: ${error instanceof Error ? error.message : String(error)}`);
      return {
        template: builtIn,
        warnings
      };
    }
  }

  private validateTemplateSelection(
    template: PromptTemplateDocument,
    scenario: PromptScenario,
    requestedVersion: string | undefined,
    capability: ModelCapability | undefined,
    warnings: string[],
    builtIn: PromptTemplateDocument
  ): LoadedPromptTemplate {
    if (requestedVersion && template.version !== requestedVersion) {
      if (this.fallback === 'error') {
        throw new Error(`Prompt template version mismatch for ${scenario}: requested "${requestedVersion}" but loaded "${template.version}".`);
      }
      warnings.push(`Requested prompt version "${requestedVersion}" was unavailable for ${scenario}; using built-in template "${builtIn.version}".`);
      return {
        template: builtIn,
        warnings
      };
    }

    if (capability && template.capabilities && template.capabilities.length > 0 && !template.capabilities.includes(capability)) {
      if (this.fallback === 'error') {
        throw new Error(`Prompt template ${template.name}@${template.version} does not support capability "${capability}".`);
      }
      warnings.push(`Prompt template ${template.name}@${template.version} does not declare capability "${capability}"; using built-in ${scenario} template.`);
      return {
        template: builtIn,
        warnings
      };
    }

    return {
      template,
      warnings
    };
  }
}

function completionDependencyBlock(request: CompletionRequest): string {
  const items = (request.dependencyHints || []).map((item) => `${item.name}${item.version ? `@${item.version}` : ''} [${item.kind}]`);
  return items.length > 0 ? listBlock('Dependency hints', items) : 'Dependency hints: none';
}

export function renderChatPrompt(
  store: PromptTemplateStore,
  request: ChatTurnRequest,
  route: ResolvedRoute,
  safetyWarnings: string[],
  observations: ToolObservation[],
  retrieval?: {
    query?: string;
    results: SearchResultItem[];
  }
): RenderedChatPrompt {
  const context = request.context;
  const visibleDocs = (context.visibleDocuments || [])
    .slice(0, 4)
    .map((doc) => `${doc.fileName}${doc.languageId ? ` (${doc.languageId})` : ''}\n${doc.excerpt}`)
    .join('\n\n---\n\n');
  const dependencies = (context.dependencyHints || []).map((item) => `${item.name}${item.version ? `@${item.version}` : ''} [${item.kind}]`);
  const relatedFiles = context.relatedFiles || [];
  const loaded = store.loadTemplate('chat', route.promptVersion, route.capability);
  const retrievalValues = retrievalBlock(retrieval?.query, retrieval?.results || []);

  const values: Record<string, string> = {
    mode: request.mode,
    promptVersion: loaded.template.version,
    capability: route.capability,
    executionPolicy:
      request.mode === 'plan' ? 'Do not propose direct file mutations unless explicitly asked.' : 'Prefer precise implementation guidance and code-aware answers.',
    safetyWarnings:
      safetyWarnings.length > 0 || loaded.warnings.length > 0
        ? `Safety notices:\n- ${[...safetyWarnings, ...loaded.warnings].join('\n- ')}`
        : 'No active safety notices.',
    userPrompt: request.prompt,
    openEditors: listBlock('Open editors', context.openEditors.slice(0, 8)),
    relatedFiles: relatedFiles.length > 0 ? listBlock('Related files', relatedFiles) : 'Related files: none',
    dependencyHints: dependencies.length > 0 ? listBlock('Dependency hints', dependencies) : 'Dependency hints: none',
    selection: context.selection ? `Selected code:\n${context.selection}` : 'Selected code: none',
    projectIndexSummary: context.projectIndexSummary ? `Project index summary:\n${context.projectIndexSummary}` : 'Project index summary: none',
    workspaceSummary: context.workspaceSummary ? `Workspace summary:\n${context.workspaceSummary}` : 'Workspace summary: none',
    gitStatus: context.gitStatus ? `Git status:\n${context.gitStatus}` : 'Git status: unavailable',
    gitDiff: context.gitDiff ? `Git diff excerpt:\n${context.gitDiff}` : 'Git diff excerpt: unavailable',
    diagnostics:
      context.diagnostics.length > 0
        ? `Diagnostics:\n${context.diagnostics.map((item) => `- ${item.file} (${item.severity}): ${item.message}`).join('\n')}`
        : 'Diagnostics: none',
    visibleDocuments: visibleDocs ? `Visible documents:\n${visibleDocs}` : 'Visible documents: none',
    retrievalQuery: retrievalValues.retrievalQuery,
    retrievalResults: retrievalValues.retrievalResults,
    observations: observationsBlock(observations)
  };

  return {
    system: interpolateTemplate(loaded.template.messages?.system || '', values),
    user: interpolateTemplate(loaded.template.messages?.user || '', values),
    templateName: loaded.template.name,
    templateVersion: loaded.template.version,
    warnings: loaded.warnings
  };
}

export function renderCompletionPrompt(
  store: PromptTemplateStore,
  request: CompletionRequest,
  requestedVersion?: string
): RenderedCompletionPrompt {
  const loaded = store.loadTemplate('completion', requestedVersion, 'completion');
  const related = request.neighbors
    .slice(0, 3)
    .map((item) => `File: ${item.fileName}\n${item.excerpt}`)
    .join('\n\n---\n\n');

  const values: Record<string, string> = {
    workspaceSummary: request.workspaceSummary ? `Workspace summary: ${request.workspaceSummary}` : 'Workspace summary: none',
    dependencyHints: completionDependencyBlock(request),
    fileName: request.fileName,
    languageId: request.languageId,
    prefix: request.prefix,
    suffix: request.suffix,
    neighborFiles: related ? `Neighbor files:\n${related}` : 'Neighbor files: none'
  };

  return {
    prompt: interpolateTemplate(loaded.template.body || '', values),
    templateName: loaded.template.name,
    templateVersion: loaded.template.version,
    warnings: loaded.warnings
  };
}
