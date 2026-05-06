import * as vscode from 'vscode';
import { runInlineCompletion } from './api.js';
import { readDependencyHints, summarizeWorkspace } from './projectIndex.js';

export class AssistantInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList> {
    if (!vscode.workspace.getConfiguration().get<boolean>('assistant.inlineCompletions.enabled', true)) {
      return new vscode.InlineCompletionList([]);
    }

    const line = document.lineAt(position.line);
    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const suffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));
    const neighbors = vscode.window.visibleTextEditors
      .filter((editor) => editor.document.uri.toString() !== document.uri.toString())
      .slice(0, 3)
      .map((editor) => ({
        fileName: editor.document.fileName,
        languageId: editor.document.languageId,
        excerpt: editor.document.getText(new vscode.Range(new vscode.Position(0, 0), editor.document.positionAt(Math.min(500, editor.document.getText().length))))
      }));
    const [workspaceSummary, dependencyHints] = await Promise.all([summarizeWorkspace(), readDependencyHints()]);

    const response = await runInlineCompletion({
      languageId: document.languageId,
      fileName: document.fileName,
      prefix,
      suffix,
      neighbors,
      workspaceSummary,
      dependencyHints
    });

    if (token.isCancellationRequested) {
      return new vscode.InlineCompletionList([]);
    }

    const items = response.items
      .filter((item) => item.text.trim().length > 0 || line.text.trim().endsWith('{'))
      .map((item) => new vscode.InlineCompletionItem(item.text));

    return new vscode.InlineCompletionList(items);
  }
}
