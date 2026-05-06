import type { ToolCall } from '@minicode/shared';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /disable (all )?(safety|guardrails)/i,
  /exfiltrat(e|ion)|dump secrets|print env/i,
  /sudo|rm\s+-rf|format c:/i
];

export interface SafetyReview {
  sanitizedPrompt: string;
  warnings: string[];
  blockedTools: string[];
}

export function reviewPrompt(prompt: string): SafetyReview {
  const sanitizedPrompt = prompt.replace(CONTROL_CHARS, ' ').trim();
  const warnings = PROMPT_INJECTION_PATTERNS.filter((pattern) => pattern.test(sanitizedPrompt)).map((pattern) => `Matched safety pattern: ${pattern}`);
  const blockedTools = warnings.length > 0 ? ['run_terminal', 'apply_patch', 'web_fetch'] : [];
  return { sanitizedPrompt, warnings, blockedTools };
}

export function reviewToolCalls(toolCalls: ToolCall[], allowedCommands: string[], blockedTools: string[]): ToolCall[] {
  return toolCalls.filter((call) => {
    if (blockedTools.includes(call.tool)) {
      return false;
    }
    if (call.tool !== 'run_terminal') {
      return true;
    }
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    if (allowedCommands.length === 0) {
      return false;
    }
    return allowedCommands.some((prefix) => command.startsWith(prefix));
  });
}
