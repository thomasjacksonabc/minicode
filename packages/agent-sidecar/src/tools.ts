import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatTurnRequest, SidecarConfig, ToolCall, ToolObservation } from '@minicode/shared';
import { isCommandRisky } from './safety.js';

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

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

export interface ExecutionStrategy {
  mode: 'process' | 'none';
  shouldIsolate: (command: string) => boolean;
}

export function createExecutionStrategy(config?: SidecarConfig['execution']): ExecutionStrategy {
  const isolationMode = config?.isolationMode || 'none';
  return {
    mode: isolationMode,
    shouldIsolate: (command: string) => {
      if (isolationMode === 'none') {
        return false;
      }
      return isCommandRisky(command);
    }
  };
}

export interface IsolatedExecutionOptions {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export async function executeInIsolation(options: IsolatedExecutionOptions): Promise<{ output: string | undefined; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'restricted' }
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, options.timeoutMs);

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      if (output.length + chunk.length <= options.maxOutputBytes) {
        output += chunk;
      } else {
        const remaining = options.maxOutputBytes - output.length;
        if (remaining > 0) {
          output += chunk.slice(0, remaining);
        }
        timedOut = true;
        proc.kill('SIGKILL');
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8');
      if (output.length + chunk.length <= options.maxOutputBytes) {
        output += chunk;
      }
    });

    proc.on('close', () => {
      clearTimeout(timeoutId);
      resolve({ output: output.trim() || undefined, timedOut });
    });

    proc.on('error', () => {
      clearTimeout(timeoutId);
      resolve({ output: undefined, timedOut: false });
    });
  });
}

function safeExec(command: string, args: string[], cwd?: string, timeoutMs?: number): string | undefined {
  try {
    const options: {
      cwd?: string;
      encoding: 'utf8';
      stdio: ['ignore', 'pipe', 'pipe' | 'ignore'];
      timeout?: number;
      maxBuffer?: number;
    } = {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    };
    if (timeoutMs && timeoutMs > 0) {
      options.timeout = timeoutMs;
    }
    const result = execFileSync(command, args, options);
    return result.trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'killed' in error && (error as { killed: boolean }).killed) {
      return undefined;
    }
    return undefined;
  }
}

function truncateOutput(output: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(output);
  if (encoded.length <= maxBytes) {
    return { text: output, truncated: false };
  }
  const truncated = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return { text: truncated, truncated: true };
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

function inferPatchInput(prompt: string, selection?: string): Record<string, unknown> {
  const quotedReplaceMatch = prompt.match(/replace\s+["'`](.+?)["'`]\s+with\s+["'`](.+?)["'`]/i);
  if (quotedReplaceMatch) {
    return {
      target: 'active-file',
      edits: [{ find: quotedReplaceMatch[1], replace: quotedReplaceMatch[2] }]
    };
  }

  const quotedChangeMatch = prompt.match(/change\s+["'`](.+?)["'`]\s+to\s+["'`](.+?)["'`]/i);
  if (quotedChangeMatch) {
    return {
      target: 'active-file',
      edits: [{ find: quotedChangeMatch[1], replace: quotedChangeMatch[2] }]
    };
  }

  const numericReplaceMatch = prompt.match(/replace\s+(\d+)\s+with\s+(\d+)/i);
  if (numericReplaceMatch) {
    return {
      target: 'active-file',
      edits: [{ find: numericReplaceMatch[1], replace: numericReplaceMatch[2] }]
    };
  }

  if (selection) {
    const appendMatch = prompt.match(/append\s+["'`](.+?)["'`]/i);
    if (appendMatch) {
      return {
        target: 'active-file',
        appendText: appendMatch[1]
      };
    }
  }

  return { target: 'active-file' };
}

export function suggestToolCalls(mode: string, prompt: string, cwd?: string, selection?: string): ToolCall[] {
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
  if (/edit|change|patch|fix|replace/i.test(prompt) && mode !== 'plan' && mode !== 'ask') {
    calls.push({
      id: randomUUID(),
      tool: 'apply_patch',
      input: inferPatchInput(prompt, selection),
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

function resolveToolTargetPath(toolCall: ToolCall, request: ChatTurnRequest, root: string): string | undefined {
  if (typeof toolCall.input.path === 'string') {
    return resolve(root, toolCall.input.path);
  }
  if (toolCall.input.target === 'active-file' && request.context.activeFile) {
    return resolve(root, request.context.activeFile);
  }
  return undefined;
}

function applyStructuredEdits(original: string, edits: Array<{ find: string; replace: string }>): { updatedText?: string; failure?: string } {
  let next = original;
  for (const edit of edits) {
    if (!edit.find) {
      return { failure: 'Patch edit is missing a non-empty find value' };
    }
    if (!next.includes(edit.find)) {
      return { failure: `Patch edit could not find target text: ${edit.find.slice(0, 80)}` };
    }
    next = next.replace(edit.find, edit.replace);
  }
  return { updatedText: next };
}

function executeApplyPatch(toolCall: ToolCall, request: ChatTurnRequest, root: string): ToolObservation {
  const targetPath = resolveToolTargetPath(toolCall, request, root);
  if (!targetPath || !existsSync(targetPath)) {
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'blocked',
      summary: 'Patch target file not found'
    };
  }

  const current = readFileSync(targetPath, 'utf8');
  if (typeof toolCall.input.replaceFile === 'string') {
    writeFileSync(targetPath, toolCall.input.replaceFile, 'utf8');
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'executed',
      summary: `Replaced file contents for ${relative(root, targetPath)}`
    };
  }

  if (typeof toolCall.input.appendText === 'string') {
    writeFileSync(targetPath, `${current}${toolCall.input.appendText}`, 'utf8');
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'executed',
      summary: `Appended text to ${relative(root, targetPath)}`
    };
  }

  if (Array.isArray(toolCall.input.edits)) {
    const edits = toolCall.input.edits.filter(
      (value): value is { find: string; replace: string } =>
        Boolean(value) &&
        typeof value === 'object' &&
        'find' in value &&
        'replace' in value &&
        typeof value.find === 'string' &&
        typeof value.replace === 'string'
    );
    if (edits.length === 0) {
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: 'blocked',
        summary: 'Patch edits payload was empty or invalid'
      };
    }
    const result = applyStructuredEdits(current, edits);
    if (!result.updatedText) {
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: 'blocked',
        summary: result.failure || 'Patch application failed'
      };
    }
    writeFileSync(targetPath, result.updatedText, 'utf8');
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'executed',
      summary: `Applied ${edits.length} patch edit(s) to ${relative(root, targetPath)}`
    };
  }

  return {
    toolCallId: toolCall.id,
    tool: toolCall.tool,
    status: 'blocked',
    summary: 'Patch payload missing; expected replaceFile, appendText, or edits'
  };
}

export function executeApprovalToolCall(
  toolCall: ToolCall,
  request: ChatTurnRequest,
  cwd: string | undefined,
  allowedCommands: string[],
  config?: SidecarConfig['execution']
): ToolObservation {
  const root = cwd || process.cwd();
  if (!toolCall.requiresApproval) {
    return {
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'blocked',
      summary: 'Tool does not require approval execution'
    };
  }

  const timeoutMs = config?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config?.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

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
      const output = safeExec('powershell', ['-NoProfile', '-Command', command], root, timeoutMs);
      if (output === undefined) {
        return {
          toolCallId: toolCall.id,
          tool: toolCall.tool,
          status: 'blocked',
          summary: `Command timed out or failed after ${timeoutMs}ms: ${command}`
        };
      }
      const { text: truncatedOutput, truncated } = truncateOutput(output, maxOutputBytes);
      return {
        toolCallId: toolCall.id,
        tool: toolCall.tool,
        status: 'executed',
        summary: truncated ? `${truncatedOutput}[Output truncated]` : truncatedOutput || 'Command completed with no output'
      };
    }
    case 'apply_patch': {
      return executeApplyPatch(toolCall, request, root);
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
