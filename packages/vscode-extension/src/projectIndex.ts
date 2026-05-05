import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeaturesDocument } from './types.js';

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

export async function summarizeFeatures(): Promise<string | undefined> {
  const document = await readFeaturesDocument();
  if (!document) {
    return undefined;
  }
  return document.features.map((feature) => `${feature.id}:${feature.status}`).join(', ');
}
