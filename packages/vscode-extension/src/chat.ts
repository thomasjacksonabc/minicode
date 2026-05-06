import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { approveTool, runChat } from './api.js';
import { getWorkspaceRoot, readDependencyHints, readGitSnapshot, summarizeFeatures, summarizeWorkspace } from './projectIndex.js';
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
  const activeLanguageId = editor?.document.languageId;
  const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
  const openEditors = vscode.window.visibleTextEditors.map((item) => item.document.uri.fsPath);
  const visibleDocuments = vscode.window.visibleTextEditors.slice(0, 4).map((item) => ({
    fileName: item.document.fileName,
    languageId: item.document.languageId,
    excerpt: item.document.getText(new vscode.Range(new vscode.Position(0, 0), item.document.positionAt(Math.min(1200, item.document.getText().length))))
  }));
  const diagnostics = vscode.languages.getDiagnostics().flatMap(([uri, items]) =>
    items.slice(0, 10).map((item) => ({
      file: uri.fsPath,
      message: item.message,
      severity: vscode.DiagnosticSeverity[item.severity]
    }))
  );
  const [{ status, diff }, projectIndexSummary, workspaceSummary, dependencyHints] = await Promise.all([
    readGitSnapshot(),
    summarizeFeatures(),
    summarizeWorkspace(),
    readDependencyHints()
  ]);
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
      activeLanguageId,
      selection,
      openEditors,
      visibleDocuments,
      diagnostics,
      gitStatus: status,
      gitDiff: diff,
      workspaceSummary,
      dependencyHints,
      projectIndexSummary
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
    for (const observation of result.observations) {
      stream.markdown(`\n\n[${observation.status}] ${observation.tool}: ${observation.summary}`);
    }
    for (const toolCall of result.toolCalls) {
      const approved = await confirmToolCall(toolCall.tool);
      await approveTool(toolCall.id, approved);
      stream.markdown(`\n\nTool ${toolCall.tool}: ${approved ? 'approved' : 'denied'}`);
    }
    if (result.metrics) {
      stream.markdown(
        `\n\nModel: ${result.metrics.model} | Route: ${result.metrics.capability} | Latency: ${result.metrics.durationMs} ms | Est. cost: $${result.metrics.estimatedCostUsd}`
      );
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
