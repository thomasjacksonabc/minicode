import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Status = 'planned' | 'in_progress' | 'done' | 'blocked';
type Area = 'extension' | 'sidecar' | 'shared' | 'infra' | 'docs';

interface FeatureRecord {
  id: string;
  title: string;
  area: Area;
  status: Status;
  summary: string;
  dependsOn: string[];
  ownedBy: string[];
  paths: string[];
  acceptanceCriteria: string[];
  notes: string[];
  lastUpdated: string;
}

interface FeaturesDocument {
  version: number;
  updatedAt: string;
  areas: Array<{ id: string; title: string }>;
  features: FeatureRecord[];
  milestones: Array<{ id: string; title: string; status: Status; featureIds: string[] }>;
  rules: Record<string, unknown>;
}

const root = resolve(process.cwd());
const filePath = resolve(root, 'features.json');
const raw = JSON.parse(readFileSync(filePath, 'utf8')) as FeaturesDocument;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(raw.version === 1, 'features.json version must be 1');
assert(Array.isArray(raw.features), 'features must be an array');

const allowedStatuses = new Set<Status>(['planned', 'in_progress', 'done', 'blocked']);
const areaIds = new Set(raw.areas.map((area) => area.id));
const ids = new Set<string>();

for (const feature of raw.features) {
  assert(feature.id.length > 0, 'feature id is required');
  assert(!ids.has(feature.id), `duplicate feature id: ${feature.id}`);
  ids.add(feature.id);
  assert(areaIds.has(feature.area), `feature ${feature.id} uses unknown area ${feature.area}`);
  assert(allowedStatuses.has(feature.status), `feature ${feature.id} has invalid status ${feature.status}`);
  assert(Array.isArray(feature.dependsOn), `feature ${feature.id} dependsOn must be an array`);
  assert(Array.isArray(feature.paths), `feature ${feature.id} paths must be an array`);
  assert(Array.isArray(feature.acceptanceCriteria), `feature ${feature.id} acceptanceCriteria must be an array`);
  assert(!Number.isNaN(Date.parse(feature.lastUpdated)), `feature ${feature.id} lastUpdated must be ISO-8601`);
}

for (const feature of raw.features) {
  for (const dependency of feature.dependsOn) {
    assert(ids.has(dependency), `feature ${feature.id} depends on missing feature ${dependency}`);
  }
}

for (const milestone of raw.milestones) {
  assert(allowedStatuses.has(milestone.status), `milestone ${milestone.id} has invalid status`);
  for (const featureId of milestone.featureIds) {
    assert(ids.has(featureId), `milestone ${milestone.id} references missing feature ${featureId}`);
  }
}

console.log(`Validated ${raw.features.length} features in ${filePath}`);
