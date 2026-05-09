import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from './agentRuntime.js';
import { PromptTemplateStore, renderChatPrompt } from './promptTemplates.js';
import type { ChatModelRequest, EmbeddingModelRequest, InlineModelRequest, ModelAdapter } from './providers.js';
import { createModelAdapter } from './providers.js';
import { chunkDocument } from './retrieval/chunker.js';
import { SemanticIndexService } from './retrieval/semanticIndex.js';
import { isManifestStale } from './retrieval/store.js';
import type { ScannedFile } from './retrieval/fileScanner.js';
import { createSidecarServer } from './server.js';
import { resolveRoute } from './routing.js';
import type { ChatTurnRequest, EmbeddingResponse, ProjectIndexBuildResponse, ProjectSearchResponse, SidecarConfig } from '@minicode/shared';

class RetrievalTestAdapter implements ModelAdapter {
  readonly id = 'retrieval-test';

  async completeChat(request: ChatModelRequest): Promise<string> {
    return request.user;
  }

  async completeInline(_request: InlineModelRequest): Promise<string[]> {
    return ['test'];
  }

  async embed(request: EmbeddingModelRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const vectors = inputs.map((input) => {
      const source = input.toLowerCase();
      return [
        source.includes('auth') || source.includes('token') ? 1 : 0,
        source.includes('search') || source.includes('index') ? 1 : 0,
        source.includes('config') ? 1 : 0,
        Math.max(1, source.split(/\s+/).filter(Boolean).length) / 10
      ];
    });
    return {
      model: request.model,
      provider: this.id,
      vectors,
      dimensions: 4
    };
  }
}

class FailingEmbeddingAdapter extends RetrievalTestAdapter {
  override async embed(_request: EmbeddingModelRequest): Promise<EmbeddingResponse> {
    throw new Error('embedding unavailable');
  }
}

function makeConfig(indexDirectory: string): SidecarConfig {
  return {
    host: '127.0.0.1',
    port: 4317,
    provider: {
      type: 'mock',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'base-model'
    },
    models: {
      chat: 'chat-model',
      reasoning: 'reasoning-model',
      completion: 'completion-model',
      embedding: 'embedding-model',
      fast: 'fast-model'
    },
    tools: {
      allowedCommands: ['npm test'],
      autoApprove: false
    },
    prompts: {
      version: 'v2'
    },
    indexing: {
      enabled: true,
      directory: indexDirectory,
      chunkSize: 120,
      chunkOverlap: 20,
      maxResults: 3
    }
  };
}

function makeRequest(cwd: string, mode: ChatTurnRequest['mode'], prompt: string): ChatTurnRequest {
  return {
    mode,
    sessionId: `${mode}-session`,
    prompt,
    cwd,
    attachments: [],
    context: {
      openEditors: ['src/auth.ts'],
      diagnostics: [],
      activeFile: 'src/auth.ts'
    }
  };
}

function setupWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'minicode-retrieval-workspace-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(
    join(workspace, 'src', 'auth.ts'),
    [
      'export function loadAuthToken(config: { token: string }) {',
      '  return config.token;',
      '}',
      '',
      'export function refreshAuthToken() {',
      '  return "auth-refresh";',
      '}'
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(workspace, 'src', 'search.ts'),
    [
      'export function buildSearchIndex(files: string[]) {',
      '  return files.length;',
      '}'
    ].join('\n'),
    'utf8'
  );
  writeFileSync(join(workspace, 'README.md'), 'This project loads auth tokens and builds a search index.', 'utf8');
  writeFileSync(join(workspace, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8');
  writeFileSync(join(workspace, 'node_modules', 'ignored', 'index.js'), 'ignored', 'utf8');
  return workspace;
}

test('mock provider embeddings are stable and predictable', async () => {
  const adapter = createModelAdapter('mock', 'http://127.0.0.1:11434');
  const first = await adapter.embed({ model: 'embedding-model', input: ['alpha beta', 'alpha beta'] });
  assert.equal(first.dimensions > 0, true);
  assert.deepEqual(first.vectors[0], first.vectors[1]);
});

test('chunkDocument preserves line ranges and overlap', () => {
  const chunks = chunkDocument(
    'src/sample.ts',
    ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n'),
    { chunkSize: 14, chunkOverlap: 7 }
  );
  assert.equal(chunks.length >= 2, true);
  assert.equal(chunks[0]?.startLine, 1);
  assert.equal(chunks[0]?.endLine >= 2, true);
  assert.equal(chunks[1]!.startLine <= chunks[0]!.endLine, true);
});

test('manifest stale detection catches file and config drift', () => {
  const files = [
    {
      absolutePath: 'c:/workspace/src/auth.ts',
      relativePath: 'src/auth.ts',
      mtimeMs: 1,
      size: 10,
      content: 'x'
    }
  ];
  assert.equal(
    isManifestStale(
      {
        workspacePath: 'c:/workspace',
        workspaceHash: 'hash',
        builtAt: 'now',
        configFingerprint: '{"chunkSize":100}',
        files: [{ filePath: 'src/auth.ts', mtimeMs: 1, size: 10 }]
      },
      files,
      '{"chunkSize":100}'
    ),
    false
  );
  assert.equal(
    isManifestStale(
      {
        workspacePath: 'c:/workspace',
        workspaceHash: 'hash',
        builtAt: 'now',
        configFingerprint: '{"chunkSize":100}',
        files: [{ filePath: 'src/auth.ts', mtimeMs: 1, size: 10 }]
      },
      files,
      '{"chunkSize":120}'
    ),
    true
  );
});

test('semantic index builds on disk and returns ranked search results', async () => {
  const workspace = setupWorkspace();
  const indexDirectory = mkdtempSync(join(tmpdir(), 'minicode-retrieval-index-'));
  const service = new SemanticIndexService(new RetrievalTestAdapter(), makeConfig(indexDirectory).indexing, 'embedding-model');

  const build = await service.buildIndex(workspace);
  assert.equal(build.ok, true);
  assert.equal((build.totalFiles || 0) >= 3, true);
  const search = await service.search({ cwd: workspace, query: 'auth token config' });
  assert.equal(search.items.length > 0, true);
  assert.equal(search.items[0]?.filePath, 'src/auth.ts');

  rmSync(indexDirectory, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test('server exposes index build and search endpoints', async () => {
  const workspace = setupWorkspace();
  const indexDirectory = mkdtempSync(join(tmpdir(), 'minicode-server-index-'));
  const runtime = new AgentRuntime(new RetrievalTestAdapter(), makeConfig(indexDirectory));
  const server = createSidecarServer({ config: makeConfig(indexDirectory), runtime, adapterId: 'retrieval-test' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const buildResponse = await fetch(`${baseUrl}/index/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: workspace })
  });
  assert.equal(buildResponse.ok, true);
  const build = (await buildResponse.json()) as ProjectIndexBuildResponse;
  assert.equal(build.ok, true);

  const searchResponse = await fetch(`${baseUrl}/index/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: workspace, query: 'search index' })
  });
  assert.equal(searchResponse.ok, true);
  const search = (await searchResponse.json()) as ProjectSearchResponse;
  assert.equal(search.items.length > 0, true);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(indexDirectory, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test('renderChatPrompt injects retrieval query and retrieval results as a separate block', () => {
  const config = makeConfig(join(tmpdir(), 'minicode-prompt-index'));
  const request = makeRequest(process.cwd(), 'ask', 'Where is auth token configured?');
  const route = resolveRoute(request, config);
  const rendered = renderChatPrompt(
    new PromptTemplateStore(config.prompts),
    request,
    route,
    [],
    [],
    {
      query: 'auth token configured',
      results: [
        {
          filePath: 'src/auth.ts',
          chunkId: 'src/auth.ts#0',
          score: 0.99,
          excerpt: 'export function loadAuthToken(config: { token: string })',
          startLine: 1,
          endLine: 2
        }
      ]
    }
  );
  assert.match(rendered.user, /Retrieval query:/);
  assert.match(rendered.user, /src\/auth\.ts:1-2/);
});

test('ask, agent, and explore chat flows mark retrieval as used after indexing', async () => {
  const workspace = setupWorkspace();
  const indexDirectory = mkdtempSync(join(tmpdir(), 'minicode-runtime-search-'));
  const config = makeConfig(indexDirectory);
  const runtime = new AgentRuntime(new RetrievalTestAdapter(), config);
  await runtime.buildProjectIndex(workspace);

  for (const mode of ['ask', 'agent', 'explore'] as const) {
    const response = await runtime.runChat(makeRequest(workspace, mode, 'Where is auth token configured?'));
    assert.equal(response.retrieval?.used, true);
    assert.equal(response.retrieval?.status, 'executed');
    assert.ok(response.observations.some((item) => item.tool === 'semantic_search' && item.status === 'executed'));
  }

  rmSync(indexDirectory, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test('chat retrieval degrades cleanly when no index exists', async () => {
  const workspace = setupWorkspace();
  const indexDirectory = mkdtempSync(join(tmpdir(), 'minicode-runtime-no-index-'));
  const runtime = new AgentRuntime(new RetrievalTestAdapter(), makeConfig(indexDirectory));
  const response = await runtime.runChat(makeRequest(workspace, 'ask', 'Where is auth token configured?'));

  assert.equal(response.retrieval?.used, false);
  assert.equal(response.retrieval?.status, 'blocked');
  assert.ok(response.observations.some((item) => item.tool === 'semantic_search' && item.status === 'blocked'));
  assert.equal(typeof response.message, 'string');

  rmSync(indexDirectory, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test('chat retrieval degrades cleanly when embeddings fail', async () => {
  const workspace = setupWorkspace();
  const indexDirectory = mkdtempSync(join(tmpdir(), 'minicode-runtime-failing-index-'));
  const workingRuntime = new AgentRuntime(new RetrievalTestAdapter(), makeConfig(indexDirectory));
  await workingRuntime.buildProjectIndex(workspace);
  const runtime = new AgentRuntime(new FailingEmbeddingAdapter(), makeConfig(indexDirectory));
  const response = await runtime.runChat(makeRequest(workspace, 'ask', 'Where is auth token configured?'));

  assert.equal(response.retrieval?.used, false);
  assert.equal(response.retrieval?.status, 'blocked');
  assert.ok(response.retrieval?.reason?.includes('embedding') || response.retrieval?.reason?.includes('unavailable'));

  rmSync(indexDirectory, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});
