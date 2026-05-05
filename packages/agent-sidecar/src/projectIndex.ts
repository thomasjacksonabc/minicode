import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FeaturesDocument } from '@minicode/shared';

export function readProjectIndex(cwd?: string): FeaturesDocument | undefined {
  const root = cwd || process.cwd();
  try {
    const raw = readFileSync(resolve(root, 'features.json'), 'utf8');
    return JSON.parse(raw) as FeaturesDocument;
  } catch {
    return undefined;
  }
}

export function summarizeProjectIndex(cwd?: string): string | undefined {
  const doc = readProjectIndex(cwd);
  if (!doc) {
    return undefined;
  }
  const summary = doc.features
    .slice(0, 5)
    .map((feature) => `${feature.id}:${feature.status}`)
    .join(', ');
  return `Project features: ${summary}`;
}
