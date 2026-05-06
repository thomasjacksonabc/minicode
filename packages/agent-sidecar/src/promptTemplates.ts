import type { ChatTurnRequest, ToolObservation } from '@minicode/shared';
import type { ResolvedRoute } from './routing.js';

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

export function renderChatPrompt(request: ChatTurnRequest, route: ResolvedRoute, safetyWarnings: string[], observations: ToolObservation[]): { system: string; user: string } {
  const context = request.context;
  const visibleDocs = (context.visibleDocuments || [])
    .slice(0, 4)
    .map((doc) => `${doc.fileName}${doc.languageId ? ` (${doc.languageId})` : ''}\n${doc.excerpt}`)
    .join('\n\n---\n\n');
  const dependencies = (context.dependencyHints || []).map((item) => `${item.name}${item.version ? `@${item.version}` : ''} [${item.kind}]`);
  const relatedFiles = context.relatedFiles || [];

  const system = [
    `You are MiniCode, an AI coding assistant operating in ${request.mode} mode.`,
    `Prompt template version: ${route.promptVersion}.`,
    `Selected capability: ${route.capability}.`,
    request.mode === 'plan' ? 'Do not propose direct file mutations unless explicitly asked.' : 'Prefer precise implementation guidance and code-aware answers.',
    'Respect project architecture, existing conventions, and user-provided constraints.',
    safetyWarnings.length > 0 ? `Safety notices:\n- ${safetyWarnings.join('\n- ')}` : 'No active safety notices.'
  ].join('\n');

  const user = [
    `User prompt:\n${request.prompt}`,
    listBlock('Open editors', context.openEditors.slice(0, 8)),
    relatedFiles.length > 0 ? listBlock('Related files', relatedFiles) : 'Related files: none',
    dependencies.length > 0 ? listBlock('Dependency hints', dependencies) : 'Dependency hints: none',
    context.selection ? `Selected code:\n${context.selection}` : 'Selected code: none',
    context.projectIndexSummary ? `Project index summary:\n${context.projectIndexSummary}` : 'Project index summary: none',
    context.workspaceSummary ? `Workspace summary:\n${context.workspaceSummary}` : 'Workspace summary: none',
    context.gitStatus ? `Git status:\n${context.gitStatus}` : 'Git status: unavailable',
    context.gitDiff ? `Git diff excerpt:\n${context.gitDiff}` : 'Git diff excerpt: unavailable',
    context.diagnostics.length > 0
      ? `Diagnostics:\n${context.diagnostics.map((item) => `- ${item.file} (${item.severity}): ${item.message}`).join('\n')}`
      : 'Diagnostics: none',
    visibleDocs ? `Visible documents:\n${visibleDocs}` : 'Visible documents: none',
    observationsBlock(observations)
  ].join('\n\n');

  return { system, user };
}

export function renderCompletionPrompt(prefix: string, suffix: string, neighbors: Array<{ fileName: string; excerpt: string }>, workspaceSummary?: string): string {
  const related = neighbors
    .slice(0, 3)
    .map((item) => `File: ${item.fileName}\n${item.excerpt}`)
    .join('\n\n---\n\n');

  return [
    'Complete the code at the cursor.',
    'Return code only, with no markdown fences or explanation.',
    workspaceSummary ? `Workspace summary: ${workspaceSummary}` : '',
    `Prefix:\n${prefix}`,
    `Suffix:\n${suffix}`,
    related ? `Neighbor files:\n${related}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}
