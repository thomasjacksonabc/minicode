import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Status = 'planned' | 'in_progress' | 'done' | 'blocked';

interface FeatureRecord {
  id: string;
  title: string;
  area: string;
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
  updatedAt: string;
  features: FeatureRecord[];
}

const root = resolve(process.cwd());
const agentsPath = resolve(root, 'AGENTS.md');
const featuresPath = resolve(root, 'features.json');
const features = JSON.parse(readFileSync(featuresPath, 'utf8')) as FeaturesDocument;
const agents = readFileSync(agentsPath, 'utf8');

const order: Status[] = ['done', 'in_progress', 'planned', 'blocked'];
const titles: Record<Status, string> = {
  done: 'Done',
  in_progress: 'In Progress',
  planned: 'Planned',
  blocked: 'Blocked'
};

const block = order
  .map((status) => {
    const rows = features.features.filter((feature) => feature.status === status);
    const lines = [`### ${titles[status]}`];
    if (rows.length === 0) {
      lines.push('- None');
    } else {
      for (const feature of rows) {
        lines.push(`- [${feature.id}] ${feature.title} (${feature.area})`);
        lines.push(`  - ${feature.summary}`);
        lines.push(`  - Paths: ${feature.paths.join(', ') || 'n/a'}`);
      }
    }
    return lines.join('\n');
  })
  .join('\n\n');

const generated = `Last synced from \`features.json\`: ${features.updatedAt}\n\n${block}`;

const next = agents.replace(
  /<!-- FEATURES:START -->[\s\S]*<!-- FEATURES:END -->/,
  `<!-- FEATURES:START -->\n${generated}\n<!-- FEATURES:END -->`
);

writeFileSync(agentsPath, next);
console.log(`Synced ${agentsPath}`);
