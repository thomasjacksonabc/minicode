import type { SidecarConfig } from '@minicode/shared';

function splitCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(): SidecarConfig {
  const defaultModel = process.env.MINICODE_PROVIDER_MODEL || 'qwen-coder-plus';
  return {
    host: process.env.MINICODE_HOST || '127.0.0.1',
    port: Number(process.env.MINICODE_PORT || 4317),
    provider: {
      type: (process.env.MINICODE_PROVIDER_TYPE as SidecarConfig['provider']['type']) || 'mock',
      baseUrl: process.env.MINICODE_PROVIDER_BASE_URL || 'http://127.0.0.1:11434',
      apiKey: process.env.MINICODE_PROVIDER_API_KEY,
      model: defaultModel
    },
    models: {
      chat: process.env.MINICODE_MODEL_CHAT || defaultModel,
      reasoning: process.env.MINICODE_MODEL_REASONING || defaultModel,
      completion: process.env.MINICODE_MODEL_COMPLETION || defaultModel,
      embedding: process.env.MINICODE_MODEL_EMBEDDING || defaultModel,
      fast: process.env.MINICODE_MODEL_FAST || defaultModel
    },
    tools: {
      allowedCommands: splitCsv(process.env.MINICODE_ALLOWED_COMMANDS),
      autoApprove: process.env.MINICODE_AUTO_APPROVE === 'true'
    },
    prompts: {
      version: process.env.MINICODE_PROMPT_VERSION || 'v2',
      directory: process.env.MINICODE_PROMPT_DIRECTORY,
      fallback: (process.env.MINICODE_PROMPT_FALLBACK as SidecarConfig['prompts']['fallback']) || 'built-in'
    },
    cache: {
      enabled: process.env.MINICODE_CACHE_ENABLED !== 'false',
      maxEntries: Number(process.env.MINICODE_CACHE_MAX_ENTRIES || 100)
    },
    streaming: {
      ssePath: process.env.MINICODE_STREAM_SSE_PATH || '/chat/stream'
    },
    indexing: {
      enabled: process.env.MINICODE_INDEXING_ENABLED !== 'false',
      directory: process.env.MINICODE_INDEX_DIRECTORY,
      chunkSize: Number(process.env.MINICODE_INDEX_CHUNK_SIZE || 800),
      chunkOverlap: Number(process.env.MINICODE_INDEX_CHUNK_OVERLAP || 120),
      maxResults: Number(process.env.MINICODE_INDEX_MAX_RESULTS || 5),
      exclude: splitCsv(process.env.MINICODE_INDEX_EXCLUDE),
      includeExtensions: splitCsv(process.env.MINICODE_INDEX_EXTENSIONS)
    }
  };
}
