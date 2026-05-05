import * as vscode from 'vscode';
import { readFeaturesDocument } from './projectIndex.js';

export class ProjectProgressProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const doc = await readFeaturesDocument();
    if (!doc) {
      return [new vscode.TreeItem('No features.json found')];
    }

    return doc.features.map((feature) => {
      const item = new vscode.TreeItem(`${feature.title} [${feature.status}]`);
      item.description = feature.id;
      item.tooltip = `${feature.summary}\nPaths: ${feature.paths.join(', ')}`;
      item.iconPath = new vscode.ThemeIcon(iconForStatus(feature.status));
      return item;
    });
  }
}

function iconForStatus(status: string): string {
  switch (status) {
    case 'done':
      return 'pass';
    case 'in_progress':
      return 'sync';
    case 'blocked':
      return 'error';
    default:
      return 'circle-large-outline';
  }
}
