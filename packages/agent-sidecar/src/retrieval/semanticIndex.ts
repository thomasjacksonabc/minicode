import type {
  ChatTurnRequest,
  ProjectIndexBuildResponse,
  ProjectSearchRequest,
  ProjectSearchResponse,
  SearchResultItem,
  SidecarConfig
} from '@minicode/shared';
import type { ModelAdapter } from '../providers.js';
import { chunkDocument } from './chunker.js';
import { defaultIndexingExcludes, defaultIndexingExtensions, scanWorkspaceFiles } from './fileScanner.js';
import {
  indexingConfigFingerprint,
  readStoredIndex,
  resolveIndexPaths,
  type IndexedChunkRecord,
  type IndexManifest,
  type IndexMetadata,
  isManifestStale,
  workspaceHash,
  writeStoredIndex
} from './store.js';

export interface RetrievalResolution {
  metadata: {
    attempted: boolean;
    used: boolean;
    status: 'executed' | 'blocked';
    query?: string;
    results: SearchResultItem[];
    reason?: string;
  };
  observation: {
    tool: 'semantic_search';
    status: 'executed' | 'blocked';
    summary: string;
  };
}

function dotProduct(left: number[], right: number[]): number {
  const limit = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < limit; index += 1) {
    sum += (left[index] || 0) * (right[index] || 0);
  }
  return sum;
}

function defaultIndexingConfig(config?: SidecarConfig['indexing']) {
  return {
    enabled: config?.enabled !== false,
    directory: config?.directory || '.minicode/index',
    chunkSize: config?.chunkSize || 800,
    chunkOverlap: config?.chunkOverlap || 120,
    maxResults: config?.maxResults || 5,
    exclude: config?.exclude?.length ? config.exclude : defaultIndexingExcludes(),
    includeExtensions: config?.includeExtensions?.length ? config.includeExtensions : defaultIndexingExtensions()
  };
}

export class SemanticIndexService {
  private readonly indexing;

  constructor(
    private readonly adapter: ModelAdapter,
    config?: SidecarConfig['indexing'],
    private readonly embeddingModel?: string
  ) {
    this.indexing = defaultIndexingConfig(config);
  }

  private indexPaths(cwd: string) {
    return resolveIndexPaths(this.indexing.directory, cwd);
  }

  private async embedTexts(inputs: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    const batchSize = 16;
    for (let index = 0; index < inputs.length; index += batchSize) {
      const batch = inputs.slice(index, index + batchSize);
      const embedded = await this.adapter.embed({
        model: this.embeddingModel || 'embedding-model',
        input: batch
      });
      vectors.push(...embedded.vectors);
    }
    return vectors;
  }

  async buildIndex(cwd: string, force = false): Promise<ProjectIndexBuildResponse> {
    const paths = this.indexPaths(cwd);
    const scannedFiles = scanWorkspaceFiles(cwd, {
      exclude: this.indexing.exclude,
      includeExtensions: this.indexing.includeExtensions
    });
    const configFingerprint = indexingConfigFingerprint(this.indexing);
    const stored = readStoredIndex(paths);
    if (!force && stored.manifest && stored.metadata && !isManifestStale(stored.manifest, scannedFiles, configFingerprint)) {
      return {
        ok: true,
        workspaceHash: stored.manifest.workspaceHash,
        builtAt: stored.metadata.builtAt,
        totalFiles: stored.metadata.totalFiles,
        totalChunks: stored.metadata.totalChunks,
        reused: true
      };
    }

    const chunkRecords = scannedFiles.flatMap((file) => chunkDocument(file.relativePath, file.content, this.indexing));
    const vectors = chunkRecords.length > 0 ? await this.embedTexts(chunkRecords.map((chunk) => chunk.text)) : [];
    const indexedChunks: IndexedChunkRecord[] = chunkRecords.map((chunk, index) => ({
      ...chunk,
      vector: vectors[index] || []
    }));
    const manifest: IndexManifest = {
      workspacePath: cwd,
      workspaceHash: workspaceHash(cwd),
      builtAt: new Date().toISOString(),
      configFingerprint,
      files: scannedFiles.map((file) => ({
        filePath: file.relativePath,
        mtimeMs: file.mtimeMs,
        size: file.size
      }))
    };
    const metadata: IndexMetadata = {
      workspaceHash: manifest.workspaceHash,
      builtAt: manifest.builtAt,
      totalFiles: scannedFiles.length,
      totalChunks: indexedChunks.length
    };
    writeStoredIndex(paths, manifest, indexedChunks, metadata);
    return {
      ok: true,
      workspaceHash: manifest.workspaceHash,
      builtAt: metadata.builtAt,
      totalFiles: metadata.totalFiles,
      totalChunks: metadata.totalChunks,
      reused: false
    };
  }

  async search(request: ProjectSearchRequest): Promise<ProjectSearchResponse> {
    const paths = this.indexPaths(request.cwd);
    const stored = readStoredIndex(paths);
    if (!stored.manifest || !stored.metadata || !stored.chunks) {
      return {
        query: request.query,
        items: [],
        warnings: ['No semantic index found for this workspace. Build the index first.']
      };
    }
    const embedded = await this.adapter.embed({
      model: this.embeddingModel || 'embedding-model',
      input: request.query
    });
    const queryVector = embedded.vectors[0] || [];
    const limit = request.limit || this.indexing.maxResults;
    const items = stored.chunks
      .map((chunk) => ({
        filePath: chunk.filePath,
        chunkId: chunk.chunkId,
        score: dotProduct(queryVector, chunk.vector),
        excerpt: chunk.excerpt,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return {
      query: request.query,
      items,
      index: {
        workspaceHash: stored.metadata.workspaceHash,
        builtAt: stored.metadata.builtAt,
        totalFiles: stored.metadata.totalFiles,
        totalChunks: stored.metadata.totalChunks
      }
    };
  }

  async resolveForChat(request: ChatTurnRequest): Promise<RetrievalResolution | undefined> {
    if (!this.indexing.enabled) {
      return {
        metadata: {
          attempted: false,
          used: false,
          status: 'blocked',
          results: [],
          reason: 'Semantic indexing is disabled.'
        },
        observation: {
          tool: 'semantic_search',
          status: 'blocked',
          summary: 'Semantic search skipped because indexing is disabled.'
        }
      };
    }
    if (!['ask', 'agent', 'explore'].includes(request.mode)) {
      return undefined;
    }

    const query = request.context.retrieval?.query || request.prompt;
    const providedResults = request.context.retrieval?.results;
    if (providedResults?.length) {
      return {
        metadata: {
          attempted: true,
          used: true,
          status: 'executed',
          query,
          results: providedResults
        },
        observation: {
          tool: 'semantic_search',
          status: 'executed',
          summary: `Semantic search injected ${providedResults.length} precomputed result(s).`
        }
      };
    }
    if (!request.cwd) {
      return {
        metadata: {
          attempted: true,
          used: false,
          status: 'blocked',
          query,
          results: [],
          reason: 'Semantic search requires a workspace directory.'
        },
        observation: {
          tool: 'semantic_search',
          status: 'blocked',
          summary: 'Semantic search skipped because the request did not include cwd.'
        }
      };
    }

    try {
      const response = await this.search({
        cwd: request.cwd,
        query,
        limit: request.context.retrieval?.maxResults
      });
      if (response.warnings?.length) {
        return {
          metadata: {
            attempted: true,
            used: false,
            status: 'blocked',
            query,
            results: [],
            reason: response.warnings.join(' ')
          },
          observation: {
            tool: 'semantic_search',
            status: 'blocked',
            summary: response.warnings.join(' ')
          }
        };
      }
      return {
        metadata: {
          attempted: true,
          used: response.items.length > 0,
          status: 'executed',
          query,
          results: response.items
        },
        observation: {
          tool: 'semantic_search',
          status: 'executed',
          summary:
            response.items.length > 0
              ? `Semantic search returned ${response.items.length} result(s) for "${query}".`
              : `Semantic search found no indexed matches for "${query}".`
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        metadata: {
          attempted: true,
          used: false,
          status: 'blocked',
          query,
          results: [],
          reason: message
        },
        observation: {
          tool: 'semantic_search',
          status: 'blocked',
          summary: `Semantic search failed and was skipped: ${message}`
        }
      };
    }
  }
}
