import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AgentRuntime } from './agentRuntime.js';
import { loadConfig } from './config.js';
import { createModelAdapter } from './providers.js';
import { getTelemetryHistory } from './telemetry.js';
import { getToolRegistry } from './tools.js';
import type { ChatTurnRequest, CompletionRequest, ToolApprovalRequest } from '@minicode/shared';

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const adapter = createModelAdapter(config.provider.type, config.provider.baseUrl, config.provider.apiKey);
  const runtime = new AgentRuntime(adapter, config);

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    try {
      if (req.method === 'GET' && url === '/health') {
        writeJson(res, 200, { ok: true, provider: adapter.id, promptVersion: config.prompts.version });
        return;
      }
      if (req.method === 'GET' && url === '/models') {
        writeJson(res, 200, { models: config.models, provider: config.provider.type });
        return;
      }
      if (req.method === 'GET' && url === '/telemetry') {
        writeJson(res, 200, { items: getTelemetryHistory() });
        return;
      }
      if ((req.method === 'GET' || req.method === 'POST') && url === '/index/search') {
        writeJson(res, 200, { items: [], query: req.method === 'POST' ? await readJson<{ query?: string }>(req) : undefined });
        return;
      }
      if (req.method === 'POST' && url === '/chat/stream') {
        const body = await readJson<ChatTurnRequest>(req);
        writeJson(res, 200, await runtime.runChat(body));
        return;
      }
      if (req.method === 'POST' && url === '/agent/run') {
        const body = await readJson<ChatTurnRequest>(req);
        writeJson(res, 200, await runtime.runChat(body));
        return;
      }
      if (req.method === 'POST' && url === '/completion/inline') {
        const body = await readJson<CompletionRequest>(req);
        writeJson(res, 200, await runtime.runCompletion(body));
        return;
      }
      if (req.method === 'POST' && url === '/tools/approve') {
        const body = await readJson<ToolApprovalRequest>(req);
        writeJson(res, 200, await runtime.approveToolCall(body.sessionId, body.toolCallId, body.approved));
        return;
      }
      if (req.method === 'GET' && url === '/tools') {
        writeJson(res, 200, { tools: getToolRegistry() });
        return;
      }
      writeJson(res, 404, { error: 'Not found' });
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  console.log(`MiniCode sidecar listening on http://${config.host}:${config.port}`);
}
