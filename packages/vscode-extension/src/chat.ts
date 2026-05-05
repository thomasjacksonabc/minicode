import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { approveTool, runChat } from './api.js';
import { getWorkspaceRoot, summarizeFeatures } from './projectIndex.js';
import type { AgentMode, AttachmentRef, ChatTurnRequest } from './types.js';

function modeFromPrompt(prompt: string): AgentMode {
  if (prompt.startsWith('/plan')) {
    return 'plan';
  }
  if (prompt.startsWith('/ask')) {
    return 'ask';
  }
  if (prompt.startsWith('/edit')) {
    return 'edit';
  }
  return 'agent';
}

async function buildRequest(prompt: string): Promise<ChatTurnRequest> {
  const editor = vscode.window.activeTextEditor;
  const activeFile = editor?.document.uri.fsPath;
  const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
  const openEditors = vscode.window.visibleTextEditors.map((item) => item.document.uri.fsPath);
  const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) =>
    items.slice(0, 10).map((item) => ({
      file: uri.fsPath,
      message: item.message,
      severity: vscode.DiagnosticSeverity[item.severity]
    }))
  );
  const attachments: AttachmentRef[] = [];
  if (activeFile) {
    attachments.push({ kind: 'file', label: vscode.workspace.asRelativePath(activeFile), value: activeFile });
  }
  return {
    mode: modeFromPrompt(prompt),
    sessionId: crypto.randomUUID(),
    prompt,
    cwd: await getWorkspaceRoot(),
    attachments,
    context: {
      activeFile,
      selection,
      openEditors,
      diagnostics,
      projectIndexSummary: await summarizeFeatures()
    }
  };
}

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant('minicode.assistant', async (request, chatContext, stream) => {
    const result = await runChat(await buildRequest(request.prompt));
    stream.markdown(result.message);
    if (result.summary) {
      stream.markdown(`\n\n${result.summary}`);
    }
    for (const toolCall of result.toolCalls) {
      const approved = await confirmToolCall(toolCall.tool);
      await approveTool(toolCall.id, approved);
      stream.markdown(`\n\nTool ${toolCall.tool}: ${approved ? 'approved' : 'denied'}`);
    }
  });

  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);
}

async function confirmToolCall(toolName: string): Promise<boolean> {
  const autoApprove = vscode.workspace.getConfiguration().get<boolean>('assistant.tools.autoApprove', false);
  if (autoApprove) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    `Assistant wants to use ${toolName}.`,
    { modal: true },
    'Approve'
  );
  return choice === 'Approve';
}
