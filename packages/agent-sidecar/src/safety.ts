import type { ToolCall } from '@minicode/shared';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /disable (all )?(safety|guardrails)/i,
  /exfiltrat(e|ion)|dump secrets|print env/i,
  /sudo|rm\s+-rf|format c:/i
];
const OUTPUT_FILTER_RULES = [
  {
    pattern: /\brm\s+-rf\b.*|Remove-Item\s+-Recurse|del\s+\/[sq]/i,
    replacement: '[filtered dangerous deletion command]',
    warning: 'Filtered dangerous deletion command from output'
  },
  {
    pattern: /(system prompt|developer prompt|api[_ -]?key|secret|token|password)/i,
    replacement: '[filtered sensitive content]',
    warning: 'Filtered sensitive prompt or secret reference from output'
  },
  {
    pattern: /\b(sudo|bypass|disable).*(guardrail|approval|safety)|ignore previous instructions/i,
    replacement: '[filtered unsafe privilege escalation guidance]',
    warning: 'Filtered unsafe privilege escalation guidance from output'
  }
] as const;

export interface SafetyReview {
  sanitizedPrompt: string;
  warnings: string[];
  blockedTools: string[];
}

export interface OutputFilterResult {
  sanitizedText: string;
  warnings: string[];
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

export function filterOutputText(text: string): OutputFilterResult {
  let sanitizedText = text;
  const warnings: string[] = [];

  for (const rule of OUTPUT_FILTER_RULES) {
    if (rule.pattern.test(sanitizedText)) {
      warnings.push(rule.warning);
      sanitizedText = sanitizedText.replace(rule.pattern, rule.replacement);
    }
  }

  return {
    sanitizedText,
    warnings
  };
}
