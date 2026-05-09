import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { SidecarConfig } from '@minicode/shared';
import type { ScannedFile } from './fileScanner.js';

export interface IndexedChunkRecord {
  chunkId: string;
  filePath: string;
  text: string;
  excerpt: string;
  startLine: number;
  endLine: number;
  vector: number[];
}

export interface IndexManifest {
  workspacePath: string;
  workspaceHash: string;
  builtAt: string;
  configFingerprint: string;
  files: Array<{
    filePath: string;
    mtimeMs: number;
    size: number;
  }>;
}

export interface IndexMetadata {
  workspaceHash: string;
  builtAt: string;
  totalFiles: number;
  totalChunks: number;
}

export interface IndexPaths {
  root: string;
  manifestPath: string;
  chunksPath: string;
  metadataPath: string;
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function workspaceHash(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
}

export function indexingConfigFingerprint(config?: SidecarConfig['indexing']): string {
  return JSON.stringify({
    chunkSize: config?.chunkSize,
    chunkOverlap: config?.chunkOverlap,
    exclude: config?.exclude,
    includeExtensions: config?.includeExtensions
  });
}

export function resolveIndexPaths(baseDirectory: string, cwd: string): IndexPaths {
  const hash = workspaceHash(cwd);
  const root = join(resolve(baseDirectory), hash);
  return {
    root,
    manifestPath: join(root, 'manifest.json'),
    chunksPath: join(root, 'chunks.json'),
    metadataPath: join(root, 'metadata.json')
  };
}

export function ensureIndexDirectory(paths: IndexPaths): void {
  mkdirSync(paths.root, { recursive: true });
}

export function isManifestStale(manifest: IndexManifest, files: ScannedFile[], configFingerprint: string): boolean {
  if (manifest.configFingerprint !== configFingerprint) {
    return true;
  }
  if (manifest.files.length !== files.length) {
    return true;
  }
  const fileMap = new Map(files.map((file) => [file.relativePath, file]));
  for (const entry of manifest.files) {
    const file = fileMap.get(entry.filePath);
    if (!file) {
      return true;
    }
    if (file.mtimeMs !== entry.mtimeMs || file.size !== entry.size) {
      return true;
    }
  }
  return false;
}

export function readStoredIndex(paths: IndexPaths): {
  manifest?: IndexManifest;
  chunks?: IndexedChunkRecord[];
  metadata?: IndexMetadata;
} {
  return {
    manifest: readJsonFile<IndexManifest>(paths.manifestPath),
    chunks: readJsonFile<IndexedChunkRecord[]>(paths.chunksPath),
    metadata: readJsonFile<IndexMetadata>(paths.metadataPath)
  };
}

export function writeStoredIndex(
  paths: IndexPaths,
  manifest: IndexManifest,
  chunks: IndexedChunkRecord[],
  metadata: IndexMetadata
): void {
  ensureIndexDirectory(paths);
  writeJsonFile(paths.manifestPath, manifest);
  writeJsonFile(paths.chunksPath, chunks);
  writeJsonFile(paths.metadataPath, metadata);
}
