import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { approveTool, runChat } from './api.js';
import { getWorkspaceRoot, readDependencyHints, readGitSnapshot, summarizeFeatures, summarizeWorkspace } from './projectIndex.js';
import type { AgentMode, AttachmentRef, ChatTurnRequest, ChatTurnResponse } from './types.js';

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
    try {
      const result = await runChat(await buildRequest(request.prompt));
      renderChatResult(stream, result);
      await processPendingToolCalls(stream, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.markdown(`\n\nRequest failed: ${message}`);
      void vscode.window.showErrorMessage(`MiniCode request failed: ${message}`);
    }
  });

  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);
}

async function processPendingToolCalls(stream: vscode.ChatResponseStream, result: ChatTurnResponse): Promise<void> {
  let pendingToolCalls = result.toolCalls;
  let sessionId = result.sessionId;

  while (pendingToolCalls.length > 0) {
    const toolCall = pendingToolCalls[0];
    const approved = await confirmToolCall(toolCall.tool, toolCall.input);
    const approvalResult = await approveTool({
      sessionId,
      toolCallId: toolCall.id,
      approved
    });

    stream.markdown(`\n\nTool ${describeToolCall(toolCall.tool, toolCall.input)}: ${approved ? 'approved' : 'denied'}`);

    if (!approvalResult.resumed) {
      const message = approvalResult.message || 'The sidecar could not resume this approval session.';
      stream.markdown(`\n\nApproval continuation failed: ${message}`);
      void vscode.window.showWarningMessage(`MiniCode approval continuation failed: ${message}`);
      return;
    }

    if (approvalResult.response) {
      sessionId = approvalResult.response.sessionId;
      renderChatResult(stream, approvalResult.response, true);
      pendingToolCalls = approvalResult.response.toolCalls;
      continue;
    }

    pendingToolCalls = pendingToolCalls.slice(1);
  }
}

function renderChatResult(stream: vscode.ChatResponseStream, result: ChatTurnResponse, isContinuation = false): void {
  if (isContinuation) {
    stream.markdown('\n\n---');
  }
  stream.markdown(isContinuation ? `\n\nContinuation:\n\n${result.message}` : result.message);
  if (result.continuation?.pending) {
    stream.markdown('\n\nPending tool approvals remain.');
  }
  if (result.summary) {
    stream.markdown(`\n\n${result.summary}`);
  }
  for (const observation of result.observations) {
    const suffix = observation.toolCallId ? ` (${observation.toolCallId})` : '';
    stream.markdown(`\n\n[${observation.status}] ${observation.tool}${suffix}: ${observation.summary}`);
  }
  if (result.metrics) {
    stream.markdown(
      `\n\nModel: ${result.metrics.model} | Route: ${result.metrics.capability} | Latency: ${result.metrics.durationMs} ms | Est. cost: $${result.metrics.estimatedCostUsd}`
    );
  }
}

function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'run_terminal' && typeof input.command === 'string') {
    return `${toolName} \`${input.command}\``;
  }
  if (toolName === 'apply_patch' && typeof input.target === 'string') {
    return `${toolName} \`${input.target}\``;
  }
  return toolName;
}

async function confirmToolCall(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const autoApprove = vscode.workspace.getConfiguration().get<boolean>('assistant.tools.autoApprove', false);
  if (autoApprove) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    `Assistant wants to use ${describeToolCall(toolName, input)}.`,
    { modal: true },
    'Approve'
  );
  return choice === 'Approve';
}
