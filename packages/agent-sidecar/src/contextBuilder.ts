import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatTurnRequest, CompletionRequest, DependencyHint } from '@minicode/shared';
import { readProjectIndex, summarizeProjectIndex } from './projectIndex.js';

interface PackageJsonShape {
  name?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(cwd?: string): PackageJsonShape | undefined {
  if (!cwd) {
    return undefined;
  }
  const filePath = resolve(cwd, 'package.json');
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

function dependencyHints(pkg?: PackageJsonShape): DependencyHint[] {
  if (!pkg) {
    return [];
  }
  const hints: DependencyHint[] = [];
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    hints.push({ name, version, kind: 'dependency' });
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    hints.push({ name, version, kind: 'devDependency' });
  }
  for (const workspace of pkg.workspaces || []) {
    hints.push({ name: workspace, kind: 'workspace' });
  }
  return hints.slice(0, 20);
}

function workspaceSummary(pkg: PackageJsonShape | undefined, cwd?: string): string | undefined {
  const projectIndex = readProjectIndex(cwd);
  if (!pkg && !projectIndex) {
    return undefined;
  }
  const parts: string[] = [];
  if (pkg?.name) {
    parts.push(`Workspace: ${pkg.name}`);
  }
  if (pkg?.workspaces?.length) {
    parts.push(`Monorepo packages: ${pkg.workspaces.join(', ')}`);
  }
  if (projectIndex) {
    const done = projectIndex.features.filter((feature) => feature.status === 'done').length;
    const inProgress = projectIndex.features.filter((feature) => feature.status === 'in_progress').length;
    parts.push(`Features done: ${done}, in progress: ${inProgress}`);
  }
  return parts.join('. ');
}

export function enrichChatContext(request: ChatTurnRequest): ChatTurnRequest {
  const pkg = readPackageJson(request.cwd);
  return {
    ...request,
    context: {
      ...request.context,
      dependencyHints: request.context.dependencyHints?.length ? request.context.dependencyHints : dependencyHints(pkg),
      workspaceSummary: request.context.workspaceSummary || workspaceSummary(pkg, request.cwd),
      projectIndexSummary: request.context.projectIndexSummary || summarizeProjectIndex(request.cwd)
    }
  };
}

export function enrichCompletionContext(request: CompletionRequest, cwd?: string): CompletionRequest {
  const pkg = readPackageJson(cwd);
  return {
    ...request,
    dependencyHints: request.dependencyHints?.length ? request.dependencyHints : dependencyHints(pkg),
    workspaceSummary: request.workspaceSummary || workspaceSummary(pkg, cwd)
  };
}
