import * as vscode from 'vscode';
import type {
  ChatStreamEvent,
  ChatTurnRequest,
  ChatTurnResponse,
  CompletionRequest,
  CompletionResponse,
  ToolApprovalRequest,
  ToolApprovalResponse
} from './types.js';

function baseUrl(): string {
  return vscode.workspace.getConfiguration().get<string>('assistant.gateway.baseUrl', 'http://127.0.0.1:4317');
}

async function postJson<TRequest, TResponse>(path: string, payload: TRequest): Promise<TResponse> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
  }

  return (await response.json()) as TResponse;
}

export async function runChat(request: ChatTurnRequest): Promise<ChatTurnResponse> {
  return postJson<ChatTurnRequest, ChatTurnResponse>('/agent/run', request);
}

function parseSseEvents(chunk: string): Array<{ event?: string; data?: string }> {
  return chunk
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      let event: string | undefined;
      const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trim());
        }
      }
      return event || data.length > 0 ? { event, data: data.join('\n') } : {};
    })
    .filter((item) => item.event || item.data);
}

export async function runChatStream(
  request: ChatTurnRequest,
  onEvent: (event: ChatStreamEvent) => void | Promise<void>
): Promise<ChatTurnResponse> {
  const response = await fetch(`${baseUrl()}/chat/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream'
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
  }
  if (!response.body) {
    throw new Error('Streaming response did not include a body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: ChatTurnResponse | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf('\n\n');
    if (boundary === -1) {
      continue;
    }
    const complete = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const parsed of parseSseEvents(complete)) {
      if (!parsed.data) {
        continue;
      }
      const event = JSON.parse(parsed.data) as ChatStreamEvent;
      await onEvent(event);
      if (event.type === 'final') {
        finalResponse = event.response;
      }
      if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    for (const parsed of parseSseEvents(buffer)) {
      if (!parsed.data) {
        continue;
      }
      const event = JSON.parse(parsed.data) as ChatStreamEvent;
      await onEvent(event);
      if (event.type === 'final') {
        finalResponse = event.response;
      }
      if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  }

  if (!finalResponse) {
    throw new Error('Streaming response completed without a final chat result.');
  }
  return finalResponse;
}

export async function runInlineCompletion(request: CompletionRequest): Promise<CompletionResponse> {
  return postJson<CompletionRequest, CompletionResponse>('/completion/inline', request);
}

export async function approveTool(request: ToolApprovalRequest): Promise<ToolApprovalResponse> {
  return postJson<ToolApprovalRequest, ToolApprovalResponse>('/tools/approve', request);
}
