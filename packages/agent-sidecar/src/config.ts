import type { SidecarConfig } from '@minicode/shared';

export function loadConfig(): SidecarConfig {
  return {
    host: process.env.MINICODE_HOST || '127.0.0.1',
    port: Number(process.env.MINICODE_PORT || 4317),
    provider: {
      type: (process.env.MINICODE_PROVIDER_TYPE as SidecarConfig['provider']['type']) || 'mock',
      baseUrl: process.env.MINICODE_PROVIDER_BASE_URL || 'http://127.0.0.1:11434',
      apiKey: process.env.MINICODE_PROVIDER_API_KEY,
      model: process.env.MINICODE_PROVIDER_MODEL || 'qwen-coder-plus'
    }
  };
}
