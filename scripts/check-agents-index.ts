import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Status = 'planned' | 'in_progress' | 'done' | 'blocked';

interface FeatureRecord {
  id: string;
  title: string;
  area: string;
  status: Status;
  summary: string;
  paths: string[];
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

function buildExpectedBlock(): string {
  const sections = order.map((status) => {
    const matching = features.features.filter((feature) => feature.status === status);
    const lines = [`### ${titles[status]}`];
    if (matching.length === 0) {
      lines.push('- None');
    } else {
      for (const feature of matching) {
        lines.push(`- [${feature.id}] ${feature.title} (${feature.area})`);
        lines.push(`  - ${feature.summary}`);
        lines.push(`  - Paths: ${feature.paths.join(', ') || 'n/a'}`);
      }
    }
    return lines.join('\n');
  });

  return `Last synced from \`features.json\`: ${features.updatedAt}\n\n${sections.join('\n\n')}`;
}

const expected = buildExpectedBlock();
const match = agents.match(/<!-- FEATURES:START -->\n([\s\S]*?)\n<!-- FEATURES:END -->/);

if (!match) {
  throw new Error('AGENTS.md is missing the generated features block');
}

if (match[1] !== expected) {
  throw new Error('AGENTS.md is out of sync with features.json. Run npm run sync:agents-index.');
}

console.log('AGENTS.md is in sync with features.json');
