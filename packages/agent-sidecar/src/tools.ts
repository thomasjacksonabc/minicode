import { randomUUID } from 'node:crypto';
import type { ToolCall } from '@minicode/shared';

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
  { name: 'workspace_symbols', description: 'Query workspace symbols', readOnly: true, requiresApproval: false },
  { name: 'semantic_search', description: 'Search indexed code chunks', readOnly: true, requiresApproval: false },
  { name: 'apply_patch', description: 'Edit files with patches', readOnly: false, requiresApproval: true },
  { name: 'run_terminal', description: 'Execute terminal commands', readOnly: false, requiresApproval: true },
  { name: 'get_terminal_output', description: 'Read terminal output', readOnly: true, requiresApproval: false },
  { name: 'diagnostics', description: 'Read diagnostics for current workspace', readOnly: true, requiresApproval: false },
  { name: 'git_status', description: 'Read git status', readOnly: true, requiresApproval: false },
  { name: 'git_diff', description: 'Read git diff', readOnly: true, requiresApproval: false },
  { name: 'web_fetch', description: 'Fetch remote content', readOnly: true, requiresApproval: true },
  { name: 'image_view', description: 'Inspect image attachments', readOnly: true, requiresApproval: false },
  { name: 'mcp_tool_bridge', description: 'Proxy MCP-backed tools', readOnly: false, requiresApproval: true }
];

export function getToolRegistry(): ToolDefinition[] {
  return registry;
}

export function suggestToolCalls(mode: string, prompt: string): ToolCall[] {
  const calls: ToolCall[] = [];
  if (/test|run|command|terminal/i.test(prompt) && mode !== 'plan') {
    calls.push({
      id: randomUUID(),
      tool: 'run_terminal',
      input: { command: 'echo "placeholder command"' },
      requiresApproval: true
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
  return calls;
}
