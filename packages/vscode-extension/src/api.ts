import * as vscode from 'vscode';
import type { ChatTurnRequest, ChatTurnResponse, CompletionRequest, CompletionResponse } from './types.js';

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
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as TResponse;
}

export async function runChat(request: ChatTurnRequest): Promise<ChatTurnResponse> {
  return postJson<ChatTurnRequest, ChatTurnResponse>('/agent/run', request);
}

export async function runInlineCompletion(request: CompletionRequest): Promise<CompletionResponse> {
  return postJson<CompletionRequest, CompletionResponse>('/completion/inline', request);
}

export async function approveTool(toolCallId: string, approved: boolean): Promise<void> {
  await postJson('/tools/approve', { toolCallId, approved });
}
