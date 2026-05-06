import type { ModelCapability } from '@minicode/shared';

export interface ChatModelRequest {
  model: string;
  capability: ModelCapability;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
}

export interface InlineModelRequest {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}

export interface ModelAdapter {
  readonly id: string;
  completeChat(request: ChatModelRequest): Promise<string>;
  completeInline(request: InlineModelRequest): Promise<string[]>;
}

function firstText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function postJson<T>(url: string, payload: unknown, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Provider request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

class MockAdapter implements ModelAdapter {
  readonly id = 'mock';

  async completeChat(request: ChatModelRequest): Promise<string> {
    const preview = request.user.slice(0, 320);
    return `[MOCK ${request.capability.toUpperCase()}] ${preview}`;
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    const trimmed = request.prompt.trimEnd();
    if (trimmed.endsWith('{')) {
      return ['\n  // TODO: implement\n}'];
    }
    return [' // TODO: implement'];
  }
}

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id = 'openai-compatible';

  constructor(private readonly endpoint: string, private readonly apiKey?: string) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async completeChat(request: ChatModelRequest): Promise<string> {
    const data = await postJson<{
      choices?: Array<{ message?: { content?: unknown } }>;
    }>(
      `${this.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user }
        ],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false
      },
      this.headers()
    );
    return firstText(data.choices?.[0]?.message?.content) || 'No response from provider.';
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    const data = await postJson<{
      choices?: Array<{ message?: { content?: unknown }; text?: string }>;
    }>(
      `${this.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        model: request.model,
        messages: [
          { role: 'system', content: 'You are a code completion model. Return code only.' },
          { role: 'user', content: request.prompt }
        ],
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false
      },
      this.headers()
    );
    const text = firstText(data.choices?.[0]?.message?.content) || data.choices?.[0]?.text || '';
    return text ? [text] : [];
  }
}

class OllamaAdapter implements ModelAdapter {
  readonly id = 'ollama';

  constructor(private readonly endpoint: string) {}

  async completeChat(request: ChatModelRequest): Promise<string> {
    const data = await postJson<{ message?: { content?: string } }>(
      `${this.endpoint.replace(/\/$/, '')}/api/chat`,
      {
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user }
        ],
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens
        }
      },
      {}
    );
    return data.message?.content || 'No response from provider.';
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    const data = await postJson<{ response?: string }>(
      `${this.endpoint.replace(/\/$/, '')}/api/generate`,
      {
        model: request.model,
        prompt: request.prompt,
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens
        }
      },
      {}
    );
    return data.response ? [data.response] : [];
  }
}

export function createModelAdapter(type: string, endpoint: string, apiKey?: string): ModelAdapter {
  switch (type) {
    case 'modelscope':
    case 'openai-compatible':
      return new OpenAICompatibleAdapter(endpoint, apiKey);
    case 'ollama':
      return new OllamaAdapter(endpoint);
    default:
      return new MockAdapter();
  }
}
