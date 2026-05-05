import * as vscode from 'vscode';
import { registerChatParticipant } from './chat.js';
import { AssistantCodeActionProvider } from './codeActions.js';
import { registerCommands } from './commands.js';
import { AssistantInlineCompletionProvider } from './completion.js';
import { ProjectProgressProvider } from './progressView.js';

export function activate(context: vscode.ExtensionContext): void {
  registerChatParticipant(context);

  const progressProvider = new ProjectProgressProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('minicode.projectProgress', progressProvider),
    vscode.languages.registerCodeActionsProvider(
      [{ pattern: '**' }],
      new AssistantCodeActionProvider(),
      { providedCodeActionKinds: AssistantCodeActionProvider.providedCodeActionKinds }
    ),
    vscode.languages.registerInlineCompletionItemProvider(
      [{ pattern: '**' }],
      new AssistantInlineCompletionProvider()
    )
  );

  registerCommands(context, () => progressProvider.refresh());
}

export function deactivate(): void {}
