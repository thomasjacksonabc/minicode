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

function isAllowedCommand(command: string, allowedCommands: string[]): boolean {
  if (allowedCommands.length === 0) {
    return false;
  }
  return allowedCommands.some((prefix) => command.startsWith(prefix));
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
            toolCallId: tool.id,
            tool: tool.tool,
            status: 'executed',
            summary: safeExec('git', ['status', '--short'], root) || 'git status unavailable'
          };
        case 'git_diff':
          return {
            toolCallId: tool.id,
            tool: tool.tool,
            status: 'executed',
            summary: (safeExec('git', ['diff', '--', '.'], root) || 'git diff unavailable').slice(0, 1800)
          };
        case 'find_files':
          return {
            toolCallId: tool.id,
            tool: tool.tool,
            status: 'executed',
            summary: simpleFindFiles(root).join(', ') || 'No files found'
          };
        case 'read_file': {
          const target = typeof tool.input.path === 'string' ? resolve(root, tool.input.path) : undefined;
          if (!target || !existsSync(target)) {
            return { toolCallId: tool.id, tool: tool.tool, status: 'blocked', summary: 'Target file not found' };
          }
          return {
            toolCallId: tool.id,
            tool: tool.tool,
            status: 'executed',
            summary: readFileSync(target, 'utf8').slice(0, 1800)
          };
        }
        default:
          return { toolCallId: tool.id, tool: tool.tool, status: 'suggested', summary: 'No executor registered yet' };
      }
    });
}

export function executeApprovalToolCall(toolCall: ToolCall, cwd: string | undefined, allowedCommands: string[]): ToolObservation {
  const root = cwd || process.cwd();
  if (!toolCall.requiresApproval) {
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'blocked',
      summary: 'Tool does not require approval execution'
    };
  }

  switch (toolCall.tool) {
    case 'run_terminal': {
      const command = typeof toolCall.input.command === 'string' ? toolCall.input.command.trim() : '';
      if (!command) {
        return {
          toolCallId: toolCall.id,
          tool: toolCall.tool,
          status: 'blocked',
          summary: 'No command provided'
        };
      }
      if (!isAllowedCommand(command, allowedCommands)) {
        return {
          toolCallId: toolCall.id,
          tool: toolCall.tool,
          status: 'blocked',
          summary: `Command blocked by allowlist: ${command}`
        };
      }
      const output = safeExec('powershell', ['-NoProfile', '-Command', command], root);
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: output === undefined ? 'blocked' : 'executed',
        summary: output === undefined ? `Command failed: ${command}` : output.slice(0, 1800) || 'Command completed with no output'
      };
    }
    case 'apply_patch': {
      const target = typeof toolCall.input.target === 'string' ? toolCall.input.target : 'unknown-target';
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: 'executed',
        summary: `apply_patch approved for ${target}; execution is stubbed in Iteration 1`
      };
    }
    default:
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: 'blocked',
        summary: 'No approval executor registered'
      };
  }
}
