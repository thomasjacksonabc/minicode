import * as vscode from 'vscode';

export class AssistantCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    if (range.isEmpty) {
      return [];
    }

    const selectionText = document.getText(range).slice(0, 200).replace(/\s+/g, ' ').trim();

    const ask = new vscode.CodeAction('Ask Assistant about Selection', vscode.CodeActionKind.QuickFix);
    ask.command = {
      command: 'workbench.action.chat.open',
      title: 'Ask Assistant',
      arguments: [`@minicode.assistant /ask ${selectionText}`]
    };

    const edit = new vscode.CodeAction('Edit Selection with Assistant', vscode.CodeActionKind.QuickFix);
    edit.command = {
      command: 'workbench.action.chat.open',
      title: 'Edit with Assistant',
      arguments: [`@minicode.assistant /edit ${selectionText}`]
    };

    return [ask, edit];
  }
}
