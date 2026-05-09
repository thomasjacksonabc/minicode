import type { EmbeddingResponse, ModelCapability } from '@minicode/shared';

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

export interface EmbeddingModelRequest {
  model: string;
  input: string | string[];
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly capability: ModelCapability,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export interface ModelAdapter {
  readonly id: string;
  completeChat(request: ChatModelRequest): Promise<string>;
  streamChat?(request: ChatModelRequest, onDelta: (delta: string) => Promise<void> | void): Promise<string>;
  completeInline(request: InlineModelRequest): Promise<string[]>;
  embed(request: EmbeddingModelRequest): Promise<EmbeddingResponse>;
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

function providerFailure(provider: string, capability: ModelCapability, error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderRequestError(message, provider, capability, error);
}

function normalizeInputs(input: string | string[]): string[] {
  return Array.isArray(input) ? input : [input];
}

function deterministicVector(text: string, dimensions = 12): number[] {
  const values = new Array<number>(dimensions).fill(0);
  const source = text.trim().toLowerCase();
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    values[index % dimensions] += ((code % 97) + 1) * ((index % 7) + 1);
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => Number((value / norm).toFixed(6)));
}

async function streamResponseLines(
  response: Response,
  onLine: (line: string) => Promise<void> | void
): Promise<void> {
  if (!response.body) {
    throw new Error('Provider streaming response did not include a body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      await onLine(line);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim().length > 0) {
    await onLine(buffer);
  }
}

class MockAdapter implements ModelAdapter {
  readonly id = 'mock';

  async completeChat(request: ChatModelRequest): Promise<string> {
    const preview = request.user.slice(0, 320);
    return `[MOCK ${request.capability.toUpperCase()}] ${preview}`;
  }

  async streamChat(request: ChatModelRequest, onDelta: (delta: string) => Promise<void> | void): Promise<string> {
    const message = await this.completeChat(request);
    const chunkSize = Math.max(24, Math.ceil(message.length / 3));
    let assembled = '';
    for (let index = 0; index < message.length; index += chunkSize) {
      const delta = message.slice(index, index + chunkSize);
      assembled += delta;
      await onDelta(delta);
    }
    return assembled;
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    const trimmed = request.prompt.trimEnd();
    if (trimmed.endsWith('{')) {
      return ['\n  // TODO: implement\n}'];
    }
    return [' // TODO: implement'];
  }

  async embed(request: EmbeddingModelRequest): Promise<EmbeddingResponse> {
    const vectors = normalizeInputs(request.input).map((entry) => deterministicVector(entry));
    return {
      model: request.model,
      provider: this.id,
      vectors,
      dimensions: vectors[0]?.length || 0
    };
  }
}

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id = 'openai-compatible';

  constructor(private readonly endpoint: string, private readonly apiKey?: string) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async completeChat(request: ChatModelRequest): Promise<string> {
    try {
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
    } catch (error) {
      throw providerFailure(this.id, 'chat', error);
    }
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    try {
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
    } catch (error) {
      throw providerFailure(this.id, 'completion', error);
    }
  }

  async streamChat(request: ChatModelRequest, onDelta: (delta: string) => Promise<void> | void): Promise<string> {
    try {
      const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers()
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ],
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true
        })
      });
      if (!response.ok) {
        throw new Error(`Provider request failed: ${response.status} ${response.statusText}`);
      }

      let assembled = '';
      await streamResponseLines(response, async (line) => {
        if (!line.startsWith('data:')) {
          return;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          return;
        }
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
        };
        const delta = firstText(parsed.choices?.[0]?.delta?.content) || firstText(parsed.choices?.[0]?.message?.content);
        if (!delta) {
          return;
        }
        assembled += delta;
        await onDelta(delta);
      });
      return assembled;
    } catch (error) {
      throw providerFailure(this.id, 'chat', error);
    }
  }

  async embed(request: EmbeddingModelRequest): Promise<EmbeddingResponse> {
    try {
      const inputs = normalizeInputs(request.input);
      const data = await postJson<{
        data?: Array<{ embedding?: number[] }>;
      }>(
        `${this.endpoint.replace(/\/$/, '')}/embeddings`,
        {
          model: request.model,
          input: inputs
        },
        this.headers()
      );
      const vectors = (data.data || []).map((entry) => entry.embedding || []);
      return {
        model: request.model,
        provider: this.id,
        vectors,
        dimensions: vectors[0]?.length || 0
      };
    } catch (error) {
      throw providerFailure(this.id, 'embedding', error);
    }
  }
}

class OllamaAdapter implements ModelAdapter {
  readonly id = 'ollama';

  constructor(private readonly endpoint: string) {}

  async completeChat(request: ChatModelRequest): Promise<string> {
    try {
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
    } catch (error) {
      throw providerFailure(this.id, 'chat', error);
    }
  }

  async completeInline(request: InlineModelRequest): Promise<string[]> {
    try {
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
    } catch (error) {
      throw providerFailure(this.id, 'completion', error);
    }
  }

  async streamChat(request: ChatModelRequest, onDelta: (delta: string) => Promise<void> | void): Promise<string> {
    try {
      const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ],
          stream: true,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Provider request failed: ${response.status} ${response.statusText}`);
      }

      let assembled = '';
      await streamResponseLines(response, async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        const parsed = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
        const delta = parsed.message?.content || '';
        if (!delta) {
          return;
        }
        assembled += delta;
        await onDelta(delta);
      });
      return assembled;
    } catch (error) {
      throw providerFailure(this.id, 'chat', error);
    }
  }

  async embed(request: EmbeddingModelRequest): Promise<EmbeddingResponse> {
    try {
      const inputs = normalizeInputs(request.input);
      const data = await postJson<{ embeddings?: number[][]; embedding?: number[] }>(
        `${this.endpoint.replace(/\/$/, '')}/api/embed`,
        {
          model: request.model,
          input: inputs
        },
        {}
      );
      const vectors = data.embeddings || (data.embedding ? [data.embedding] : []);
      return {
        model: request.model,
        provider: this.id,
        vectors,
        dimensions: vectors[0]?.length || 0
      };
    } catch (error) {
      throw providerFailure(this.id, 'embedding', error);
    }
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
