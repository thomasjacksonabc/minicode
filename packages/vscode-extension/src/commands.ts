import * as vscode from 'vscode';

export function registerCommands(context: vscode.ExtensionContext, refreshProjectProgress: () => void): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('minicode.askWithAssistant', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', '@minicode.assistant /ask ');
    }),
    vscode.commands.registerCommand('minicode.editWithAssistant', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', '@minicode.assistant /edit ');
    }),
    vscode.commands.registerCommand('minicode.refreshProjectProgress', () => {
      refreshProjectProgress();
    })
  );
}
