import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
  content: string;
}

const DEFAULT_EXCLUDED_DIRS = ['.git', 'node_modules', 'dist', 'build'];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml'];
const DEFAULT_LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 512);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export function defaultIndexingExcludes(): string[] {
  return [...DEFAULT_EXCLUDED_DIRS];
}

export function defaultIndexingExtensions(): string[] {
  return [...DEFAULT_EXTENSIONS];
}

export function scanWorkspaceFiles(
  cwd: string,
  options?: {
    exclude?: string[];
    includeExtensions?: string[];
  }
): ScannedFile[] {
  const excluded = new Set(options?.exclude || DEFAULT_EXCLUDED_DIRS);
  const allowedExtensions = new Set((options?.includeExtensions || DEFAULT_EXTENSIONS).map((item) => item.toLowerCase()));
  const results: ScannedFile[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) {
          continue;
        }
        visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (DEFAULT_LOCK_FILES.has(entry.name)) {
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      const raw = readFileSync(absolutePath);
      if (isBinaryBuffer(raw)) {
        continue;
      }

      const stats = statSync(absolutePath);
      results.push({
        absolutePath,
        relativePath: relative(cwd, absolutePath).replace(/\\/g, '/'),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        content: raw.toString('utf8')
      });
    }
  };

  visit(cwd);
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
