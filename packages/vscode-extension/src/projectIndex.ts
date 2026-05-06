import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DependencyHint, FeaturesDocument } from './types.js';

const execFileAsync = promisify(execFile);

interface PackageJsonShape {
  name?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function getWorkspaceRoot(): Promise<string | undefined> {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function readFeaturesDocument(): Promise<FeaturesDocument | undefined> {
  const root = await getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  const relativePath = vscode.workspace.getConfiguration().get<string>('assistant.projectIndex.featuresFile', 'features.json');
  try {
    const content = await readFile(path.join(root, relativePath), 'utf8');
    return JSON.parse(content) as FeaturesDocument;
  } catch {
    return undefined;
  }
}

async function readPackageJson(root: string): Promise<PackageJsonShape | undefined> {
  try {
    const content = await readFile(path.join(root, 'package.json'), 'utf8');
    return JSON.parse(content) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

export async function summarizeFeatures(): Promise<string | undefined> {
  const document = await readFeaturesDocument();
  if (!document) {
    return undefined;
  }
  return document.features.map((feature) => `${feature.id}:${feature.status}`).join(', ');
}

export async function readDependencyHints(): Promise<DependencyHint[]> {
  const root = await getWorkspaceRoot();
  if (!root) {
    return [];
  }
  const pkg = await readPackageJson(root);
  if (!pkg) {
    return [];
  }
  const items: DependencyHint[] = [];
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    items.push({ name, version, kind: 'dependency' });
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    items.push({ name, version, kind: 'devDependency' });
  }
  for (const workspace of pkg.workspaces || []) {
    items.push({ name: workspace, kind: 'workspace' });
  }
  return items.slice(0, 20);
}

export async function summarizeWorkspace(): Promise<string | undefined> {
  const root = await getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  const [features, pkg] = await Promise.all([readFeaturesDocument(), readPackageJson(root)]);
  const parts: string[] = [];
  if (pkg?.name) {
    parts.push(`Workspace ${pkg.name}`);
  }
  if (pkg?.workspaces?.length) {
    parts.push(`Packages: ${pkg.workspaces.join(', ')}`);
  }
  if (features) {
    const done = features.features.filter((item) => item.status === 'done').length;
    const inProgress = features.features.filter((item) => item.status === 'in_progress').length;
    parts.push(`Features done ${done}, in progress ${inProgress}`);
  }
  return parts.join('. ');
}

export async function readGitSnapshot(): Promise<{ status?: string; diff?: string }> {
  const root = await getWorkspaceRoot();
  if (!root) {
    return {};
  }
  try {
    const [status, diff] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd: root, windowsHide: true }),
      execFileAsync('git', ['diff', '--', '.'], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 })
    ]);
    return {
      status: status.stdout.trim() || undefined,
      diff: diff.stdout.trim().slice(0, 4000) || undefined
    };
  } catch {
    return {};
  }
}
