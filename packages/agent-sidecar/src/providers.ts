import type { ChatTurnRequest, CompletionRequest } from '@minicode/shared';

export interface ModelAdapter {
  readonly id: string;
  completeChat(request: ChatTurnRequest): Promise<string>;
  completeInline(request: CompletionRequest): Promise<string[]>;
}

class MockAdapter implements ModelAdapter {
  readonly id = 'mock';

  async completeChat(request: ChatTurnRequest): Promise<string> {
    const header = `[${request.mode.toUpperCase()}]`;
    const contextHint = request.context.activeFile ? ` Active file: ${request.context.activeFile}.` : '';
    const planGuard = request.mode === 'plan' ? ' Plan mode is read-only.' : '';
    return `${header} ${request.prompt}${contextHint}${planGuard}`.trim();
  }

  async completeInline(request: CompletionRequest): Promise<string[]> {
    const trimmed = request.prefix.trimEnd();
    if (trimmed.endsWith('{')) {
      return ['\n  // TODO: implement\n}'];
    }
    if (request.languageId === 'typescript' || request.languageId === 'javascript') {
      return [' // TODO: implement'];
    }
    return [''];
  }
}

class PassThroughAdapter implements ModelAdapter {
  constructor(readonly id: string, private readonly endpoint: string) {}

  async completeChat(request: ChatTurnRequest): Promise<string> {
    return `Provider ${this.id} is configured at ${this.endpoint}. Request captured for: ${request.prompt}`;
  }

  async completeInline(request: CompletionRequest): Promise<string[]> {
    return [` /* ${this.id} suggestion for ${request.fileName} */`];
  }
}

export function createModelAdapter(type: string, endpoint: string): ModelAdapter {
  switch (type) {
    case 'modelscope':
      return new PassThroughAdapter('modelscope', endpoint);
    case 'openai-compatible':
      return new PassThroughAdapter('openai-compatible', endpoint);
    case 'ollama':
      return new PassThroughAdapter('ollama', endpoint);
    default:
      return new MockAdapter();
  }
}
