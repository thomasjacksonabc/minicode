import type {
  ChatTurnRequest,
  ChatTurnResponse,
  CompletionRequest,
  CompletionResponse,
  SidecarConfig,
  ToolApprovalResponse,
  ToolCall,
  ToolObservation
} from '@minicode/shared';
import type { ModelAdapter } from './providers.js';
import { enrichChatContext, enrichCompletionContext } from './contextBuilder.js';
import { renderChatPrompt, renderCompletionPrompt } from './promptTemplates.js';
import type { ResolvedRoute } from './routing.js';
import { resolveRoute } from './routing.js';
import { filterOutputText, reviewPrompt, reviewToolCalls } from './safety.js';
import { buildUsageMetrics } from './telemetry.js';
import { executeApprovalToolCall, executeReadOnlyToolCalls, suggestToolCalls } from './tools.js';

interface PendingSession {
  request: ChatTurnRequest;
  pendingToolCalls: ToolCall[];
  observations: ToolObservation[];
  warnings: string[];
}

export class AgentRuntime {
  private readonly sessions = new Map<string, PendingSession>();

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly config: SidecarConfig
  ) {}

  hasPendingSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private summarize(request: ChatTurnRequest, observations: ToolObservation[], warnings: string[]): string {
    const summaryParts = [
      request.context.projectIndexSummary ? `Project index: ${request.context.projectIndexSummary}` : undefined,
      observations.length > 0 ? `Observed ${observations.length} tool event(s)` : undefined,
      warnings.length > 0 ? `Safety warnings: ${warnings.length}` : undefined
    ].filter(Boolean);
    return summaryParts.join('. ');
  }

  private buildBlockedToolObservations(allToolCalls: ToolCall[], safeToolCalls: ToolCall[]): ToolObservation[] {
    const safeIds = new Set(safeToolCalls.map((call) => call.id));
    return allToolCalls
      .filter((call) => !safeIds.has(call.id))
      .map((call) => ({
        toolCallId: call.id,
        tool: call.tool,
        status: 'blocked' as const,
        summary: `Tool blocked by safety policy: ${call.tool}`
      }));
  }

  private buildSuggestedObservations(toolCalls: ToolCall[]): ToolObservation[] {
    return toolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      tool: toolCall.tool,
      status: 'suggested' as const,
      summary: `Tool suggested and awaiting approval: ${toolCall.tool}`
    }));
  }

  private applyOutputFilters(observations: ToolObservation[], message?: string): { observations: ToolObservation[]; message?: string; warnings: string[] } {
    const warnings: string[] = [];
    const filteredObservations = observations.map((observation) => {
      const filtered = filterOutputText(observation.summary);
      warnings.push(...filtered.warnings);
      return filtered.warnings.length > 0
        ? {
            ...observation,
            summary: filtered.sanitizedText
          }
        : observation;
    });

    let filteredMessage = message;
    if (typeof message === 'string') {
      const filtered = filterOutputText(message);
      warnings.push(...filtered.warnings);
      filteredMessage = filtered.sanitizedText;
    }

    return { observations: filteredObservations, message: filteredMessage, warnings };
  }

  private async completeChatTurn(
    request: ChatTurnRequest,
    route: ResolvedRoute,
    warnings: string[],
    observations: ToolObservation[],
    resumedFromToolCallId?: string
  ): Promise<ChatTurnResponse> {
    const startedAt = Date.now();
    const filteredObservationOutput = this.applyOutputFilters(observations);
    const { system, user } = renderChatPrompt(request, route, warnings, filteredObservationOutput.observations);
    const rawMessage = await this.adapter.completeChat({
      model: route.model,
      capability: route.capability,
      system,
      user,
      temperature: route.temperature,
      maxTokens: route.maxTokens
    });
    const filteredMessageOutput = this.applyOutputFilters([], rawMessage);
    const allWarnings = [...warnings, ...filteredObservationOutput.warnings, ...filteredMessageOutput.warnings];
    const metrics = buildUsageMetrics({
      startedAt,
      inputText: `${system}\n\n${user}`,
      outputText: filteredMessageOutput.message || '',
      capability: route.capability,
      model: route.model,
      provider: this.adapter.id,
      promptVersion: route.promptVersion
    });
    const outputFilterObservations =
      filteredObservationOutput.warnings.length > 0 || filteredMessageOutput.warnings.length > 0
        ? [
            {
              tool: 'safety',
              status: 'blocked' as const,
              summary: Array.from(new Set([...filteredObservationOutput.warnings, ...filteredMessageOutput.warnings])).join('; ')
            }
          ]
        : [];

    return {
      sessionId: request.sessionId,
      mode: request.mode,
      message: filteredMessageOutput.message || '',
      toolCalls: [],
      observations: [...filteredObservationOutput.observations, ...outputFilterObservations],
      continuation: resumedFromToolCallId
        ? {
            pending: false,
            resumedFromToolCallId
          }
        : undefined,
      summary: this.summarize(request, [...filteredObservationOutput.observations, ...outputFilterObservations], allWarnings),
      metrics
    };
  }

  async runChat(request: ChatTurnRequest): Promise<ChatTurnResponse> {
    const reviewed = reviewPrompt(request.prompt);
    const enrichedRequest = enrichChatContext({
      ...request,
      prompt: reviewed.sanitizedPrompt
    });
    const route: ResolvedRoute = resolveRoute(enrichedRequest, this.config);
    const suggestedToolCalls = suggestToolCalls(enrichedRequest.mode, enrichedRequest.prompt, enrichedRequest.cwd);
    const safeToolCalls = reviewToolCalls(suggestedToolCalls, this.config.tools.allowedCommands, reviewed.blockedTools);
    const readOnlyObservations = executeReadOnlyToolCalls(safeToolCalls, enrichedRequest.cwd);
    const pendingToolCalls = safeToolCalls.filter((call) => call.requiresApproval);
    const blockedObservations = this.buildBlockedToolObservations(suggestedToolCalls, safeToolCalls);
    const pendingObservations = this.buildSuggestedObservations(pendingToolCalls);
    const observations = [...blockedObservations, ...readOnlyObservations, ...pendingObservations];

    const response = await this.completeChatTurn(enrichedRequest, route, reviewed.warnings, observations);
    response.toolCalls = pendingToolCalls;
    response.continuation = pendingToolCalls.length > 0 ? { pending: true } : { pending: false };

    if (pendingToolCalls.length > 0) {
      this.sessions.set(request.sessionId, {
        request: enrichedRequest,
        pendingToolCalls,
        observations: response.observations,
        warnings: reviewed.warnings
      });
    } else {
      this.sessions.delete(request.sessionId);
    }

    return response;
  }

  async approveToolCall(sessionId: string, toolCallId: string, approved: boolean): Promise<ToolApprovalResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { sessionId, toolCallId, approved, resumed: false, message: 'No pending approval session was found for this request.' };
    }

    const toolCall = session.pendingToolCalls.find((entry) => entry.id === toolCallId);
    if (!toolCall) {
      return { sessionId, toolCallId, approved, resumed: false, message: 'The requested tool call is no longer pending in this session.' };
    }

    const remainingToolCalls = session.pendingToolCalls.filter((entry) => entry.id !== toolCallId);
    const approvalObservation: ToolObservation = {
      toolCallId,
      tool: toolCall.tool,
      status: approved ? 'approved' : 'denied',
      summary: approved ? `User approved ${toolCall.tool}` : `User denied ${toolCall.tool}`
    };

    const followUpObservations = [approvalObservation];
    if (approved) {
      followUpObservations.push(executeApprovalToolCall(toolCall, session.request.cwd, this.config.tools.allowedCommands));
    }

    const previousPendingIds = new Set(session.pendingToolCalls.map((entry) => entry.id));
    const baseObservations = session.observations.filter(
      (observation) => !(observation.status === 'suggested' && observation.toolCallId && previousPendingIds.has(observation.toolCallId))
    );
    const resumedObservations = [...baseObservations, ...followUpObservations];
    const deltaObservations = [...followUpObservations];
    if (remainingToolCalls.length > 0) {
      const remainingSuggestions = this.buildSuggestedObservations(remainingToolCalls);
      resumedObservations.push(...remainingSuggestions);
      deltaObservations.push(...remainingSuggestions);
    }

    const updatedSession: PendingSession = {
      ...session,
      pendingToolCalls: remainingToolCalls,
      observations: resumedObservations
    };

    if (remainingToolCalls.length > 0) {
      this.sessions.set(sessionId, updatedSession);
    } else {
      this.sessions.delete(sessionId);
    }

    const route = resolveRoute(session.request, this.config);
    const response = await this.completeChatTurn(session.request, route, updatedSession.warnings, resumedObservations, toolCallId);
    response.toolCalls = remainingToolCalls;
    const deltaToolCallIds = new Set(deltaObservations.map((item) => item.toolCallId).filter((item): item is string => Boolean(item)));
    response.observations = response.observations.filter(
      (observation) => observation.tool === 'safety' || (observation.toolCallId ? deltaToolCallIds.has(observation.toolCallId) : false)
    );
    response.continuation = {
      pending: remainingToolCalls.length > 0,
      resumedFromToolCallId: toolCallId
    };
    response.summary = this.summarize(session.request, response.observations, updatedSession.warnings);

    return {
      sessionId,
      toolCallId,
      approved,
      resumed: true,
      message: approved ? `Resumed session after approving ${toolCall.tool}.` : `Recorded denial for ${toolCall.tool}.`,
      response
    };
  }

  async runCompletion(request: CompletionRequest, cwd?: string): Promise<CompletionResponse> {
    const startedAt = Date.now();
    const enrichedRequest = enrichCompletionContext(request, cwd);
    const prompt = renderCompletionPrompt(
      enrichedRequest.prefix,
      enrichedRequest.suffix,
      enrichedRequest.neighbors,
      enrichedRequest.workspaceSummary
    );
    const model = this.config.models.completion || this.config.provider.model;
    const suggestions = await this.adapter.completeInline({
      model,
      prompt,
      temperature: 0.15,
      maxTokens: 240
    });
    const text = suggestions.join('\n').trim();
    const metrics = buildUsageMetrics({
      startedAt,
      inputText: prompt,
      outputText: text,
      capability: 'completion',
      model,
      provider: this.adapter.id,
      promptVersion: this.config.prompts.version
    });
    return {
      items: suggestions
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => ({
          text: entry,
          detail: `Generated by ${this.adapter.id} using ${model}`
        })),
      metrics
    };
  }
}
