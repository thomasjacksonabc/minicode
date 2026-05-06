import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolCall, ToolObservation } from '@minicode/shared';

export interface ToolDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  requiresApproval: boolean;
}

const registry: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file from disk', readOnly: true, requiresApproval: false },
  { name: 'find_text', description: 'Search text in the workspace', readOnly: true, requiresApproval: false },
  { name: 'find_files', description: 'Search files by glob', readOnly: true, requiresApproval: false },
  { name: 'git_status', description: 'Read git status', readOnly: true, requiresApproval: false },
  { name: 'git_diff', description: 'Read git diff', readOnly: true, requiresApproval: false },
  { name: 'apply_patch', description: 'Edit files with patches', readOnly: false, requiresApproval: true },
  { name: 'run_terminal', description: 'Execute terminal commands', readOnly: false, requiresApproval: true }
];

function safeExec(command: string, args: string[], cwd?: string): string | undefined {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

function simpleFindFiles(root: string, limit = 12): string[] {
  const result: string[] = [];
  const queue = [root];
  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') {
        continue;
      }
      const fullPath = join(current, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        queue.push(fullPath);
      } else {
        result.push(relative(root, fullPath));
        if (result.length >= limit) {
          break;
        }
      }
    }
  }
  return result;
}

export function getToolRegistry(): ToolDefinition[] {
  return registry;
}

export function suggestToolCalls(mode: string, prompt: string, cwd?: string): ToolCall[] {
  const calls: ToolCall[] = [];
  if (/git status|working tree|changed files/i.test(prompt)) {
    calls.push({
      id: randomUUID(),
      tool: 'git_status',
      input: { cwd },
      requiresApproval: false
    });
  }
  if (/git diff|diff|patch summary/i.test(prompt)) {
    calls.push({
      id: randomUUID(),
      tool: 'git_diff',
      input: { cwd },
      requiresApproval: false
    });
  }
  if (/find|search|where is|locate/i.test(prompt)) {
    calls.push({
      id: randomUUID(),
      tool: 'find_files',
      input: { cwd, query: prompt },
      requiresApproval: false
    });
  }
  if (/edit|change|patch|fix/i.test(prompt) && mode !== 'plan' && mode !== 'ask') {
    calls.push({
      id: randomUUID(),
      tool: 'apply_patch',
      input: { target: 'active-file' },
      requiresApproval: true
    });
  }
  if (/run|command|terminal|npm test|npm run/i.test(prompt) && mode !== 'plan') {
    calls.push({
      id: randomUUID(),
      tool: 'run_terminal',
      input: { command: 'npm test' },
      requiresApproval: true
    });
  }
  return calls;
}

export function executeReadOnlyToolCalls(toolCalls: ToolCall[], cwd?: string): ToolObservation[] {
  const root = cwd || process.cwd();
  return toolCalls
    .filter((tool) => !tool.requiresApproval)
    .map((tool): ToolObservation => {
      switch (tool.tool) {
        case 'git_status':
          return {
            tool: tool.tool,
            status: 'executed',
            summary: safeExec('git', ['status', '--short'], root) || 'git status unavailable'
          };
        case 'git_diff':
          return {
            tool: tool.tool,
            status: 'executed',
            summary: (safeExec('git', ['diff', '--', '.'], root) || 'git diff unavailable').slice(0, 1800)
          };
        case 'find_files':
          return {
            tool: tool.tool,
            status: 'executed',
            summary: simpleFindFiles(root).join(', ') || 'No files found'
          };
        case 'read_file': {
          const target = typeof tool.input.path === 'string' ? resolve(root, tool.input.path) : undefined;
          if (!target || !existsSync(target)) {
            return { tool: tool.tool, status: 'blocked', summary: 'Target file not found' };
          }
          return {
            tool: tool.tool,
            status: 'executed',
            summary: readFileSync(target, 'utf8').slice(0, 1800)
          };
        }
        default:
          return { tool: tool.tool, status: 'suggested', summary: 'No executor registered yet' };
      }
    });
}
