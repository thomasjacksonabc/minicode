import type {
  ChatStreamEvent,
  ChatTurnRequest,
  ChatTurnResponse,
  CompletionRequest,
  CompletionResponse,
  ProjectIndexBuildResponse,
  ProjectSearchRequest,
  ProjectSearchResponse,
  ResponseCacheMetadata,
  SidecarConfig,
  ToolApprovalResponse,
  ToolCall,
  ToolObservation
} from '@minicode/shared';
import type { ModelAdapter } from './providers.js';
import { enrichChatContext, enrichCompletionContext } from './contextBuilder.js';
import { PromptTemplateStore, renderChatPrompt, renderCompletionPrompt, type RenderedChatPrompt } from './promptTemplates.js';
import { createCacheKey, ResponseCache } from './responseCache.js';
import { SemanticIndexService } from './retrieval/semanticIndex.js';
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

interface PreparedChatTurn {
  request: ChatTurnRequest;
  route: ResolvedRoute;
  warnings: string[];
  observations: ToolObservation[];
  pendingToolCalls: ToolCall[];
  retrieval?: ChatTurnResponse['retrieval'];
  renderedPrompt?: RenderedChatPrompt;
  promptInputText?: string;
  cacheKey?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class AgentRuntime {
  private readonly sessions = new Map<string, PendingSession>();
  private readonly promptTemplates: PromptTemplateStore;
  private readonly chatCache: ResponseCache<ChatTurnResponse>;
  private readonly completionCache: ResponseCache<CompletionResponse>;
  private readonly streamingPath: string;
  private readonly semanticIndex: SemanticIndexService;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly config: SidecarConfig
  ) {
    this.promptTemplates = new PromptTemplateStore(config.prompts);
    this.chatCache = new ResponseCache('chat', config.cache);
    this.completionCache = new ResponseCache('completion', config.cache);
    this.streamingPath = config.streaming?.ssePath || '/chat/stream';
    this.semanticIndex = new SemanticIndexService(adapter, config.indexing, config.models.embedding || config.provider.model);
  }

  hasPendingSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private summarize(request: ChatTurnRequest, observations: ToolObservation[], warnings: string[]): string {
    const summaryParts = [
      request.context.projectIndexSummary ? `Project index: ${request.context.projectIndexSummary}` : undefined,
      observations.length > 0 ? `Observed ${observations.length} tool event(s)` : undefined,
      warnings.length > 0 ? `Warnings: ${warnings.join(' | ')}` : undefined
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

  private normalizeChatResponse(
    request: ChatTurnRequest,
    route: ResolvedRoute,
    warnings: string[],
    observations: ToolObservation[],
    message: string,
    startedAt: number,
    options?: {
      pendingToolCalls?: ToolCall[];
      resumedFromToolCallId?: string;
      cache?: ResponseCacheMetadata;
      firstEventLatencyMs?: number;
      promptInputText?: string;
    }
  ): ChatTurnResponse {
    const filteredObservationOutput = this.applyOutputFilters(observations);
    const filteredMessageOutput = this.applyOutputFilters([], message);
    const allWarnings = [...warnings, ...filteredObservationOutput.warnings, ...filteredMessageOutput.warnings];
    const metrics = buildUsageMetrics({
      startedAt,
      inputText: options?.promptInputText || '',
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
      toolCalls: options?.pendingToolCalls || [],
      observations: [...filteredObservationOutput.observations, ...outputFilterObservations],
      continuation: options?.resumedFromToolCallId
        ? {
            pending: (options.pendingToolCalls || []).length > 0,
            resumedFromToolCallId: options.resumedFromToolCallId
          }
        : {
            pending: (options?.pendingToolCalls || []).length > 0
          },
      cache: options?.cache,
      streaming: {
        transport: 'sse',
        path: this.streamingPath,
        firstEventLatencyMs: options?.firstEventLatencyMs,
        completed: true
      },
      summary: this.summarize(request, [...filteredObservationOutput.observations, ...outputFilterObservations], allWarnings),
      metrics: {
        ...metrics,
        promptVersion: route.promptVersion
      }
    };
  }

  private async prepareChatTurn(request: ChatTurnRequest): Promise<PreparedChatTurn> {
    const reviewed = reviewPrompt(request.prompt);
    const enrichedRequest = enrichChatContext({
      ...request,
      prompt: reviewed.sanitizedPrompt
    });
    const route = resolveRoute(enrichedRequest, this.config);
    const suggestedToolCalls = suggestToolCalls(
      enrichedRequest.mode,
      enrichedRequest.prompt,
      enrichedRequest.cwd,
      enrichedRequest.context.selection
    );
    const safeToolCalls = reviewToolCalls(suggestedToolCalls, this.config.tools.allowedCommands, reviewed.blockedTools);
    const readOnlyObservations = executeReadOnlyToolCalls(safeToolCalls, enrichedRequest.cwd);
    const pendingToolCalls = safeToolCalls.filter((call) => call.requiresApproval);
    const blockedObservations = this.buildBlockedToolObservations(suggestedToolCalls, safeToolCalls);
    const pendingObservations = this.buildSuggestedObservations(pendingToolCalls);
    const retrievalResolution = await this.semanticIndex.resolveForChat(enrichedRequest);
    const observations = [
      ...blockedObservations,
      ...readOnlyObservations,
      ...(retrievalResolution ? [retrievalResolution.observation] : []),
      ...pendingObservations
    ];
    const renderedPrompt = renderChatPrompt(
      this.promptTemplates,
      enrichedRequest,
      route,
      reviewed.warnings,
      observations,
      retrievalResolution?.metadata.query
        ? {
            query: retrievalResolution.metadata.query,
            results: retrievalResolution.metadata.results
          }
        : undefined
    );
    const allWarnings = [...reviewed.warnings, ...renderedPrompt.warnings];
    const actualRoute = renderedPrompt.templateVersion === route.promptVersion ? route : { ...route, promptVersion: renderedPrompt.templateVersion };
    const promptInputText = `${renderedPrompt.system}\n\n${renderedPrompt.user}`;
    const cacheKey =
      pendingToolCalls.length === 0
        ? createCacheKey('chat', {
            mode: enrichedRequest.mode,
            prompt: enrichedRequest.prompt,
            cwd: enrichedRequest.cwd,
            attachments: enrichedRequest.attachments,
            context: enrichedRequest.context,
            route: actualRoute,
            observations
          })
        : undefined;

    return {
      request: enrichedRequest,
      route: actualRoute,
      warnings: allWarnings,
      observations,
      pendingToolCalls,
      retrieval: retrievalResolution?.metadata,
      renderedPrompt,
      promptInputText,
      cacheKey
    };
  }

  private async completePendingSession(session: PendingSession, toolCallId: string, approved: boolean, startedAt: number): Promise<ChatTurnResponse> {
    const toolCall = session.pendingToolCalls.find((entry) => entry.id === toolCallId);
    if (!toolCall) {
      throw new Error('Tool call is no longer pending.');
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
      followUpObservations.push(executeApprovalToolCall(toolCall, session.request, session.request.cwd, this.config.tools.allowedCommands, this.config.execution));
    }

    const previousPendingIds = new Set(session.pendingToolCalls.map((entry) => entry.id));
    const baseObservations = session.observations.filter((observation) => {
      if (observation.tool === 'semantic_search') {
        return false;
      }
      return !(observation.status === 'suggested' && observation.toolCallId && previousPendingIds.has(observation.toolCallId));
    });
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
      this.sessions.set(session.request.sessionId, updatedSession);
    } else {
      this.sessions.delete(session.request.sessionId);
    }

    const route = resolveRoute(session.request, this.config);
    const retrievalResolution = await this.semanticIndex.resolveForChat(session.request);
    if (retrievalResolution) {
      resumedObservations.unshift(retrievalResolution.observation);
    }
    const renderedPrompt = renderChatPrompt(
      this.promptTemplates,
      session.request,
      { ...route, promptVersion: route.promptVersion },
      updatedSession.warnings,
      resumedObservations,
      retrievalResolution?.metadata.query
        ? {
            query: retrievalResolution.metadata.query,
            results: retrievalResolution.metadata.results
          }
        : undefined
    );
    const actualRoute = renderedPrompt.templateVersion === route.promptVersion ? route : { ...route, promptVersion: renderedPrompt.templateVersion };

    return this.adapter.completeChat({
      model: actualRoute.model,
      capability: actualRoute.capability,
      system: renderedPrompt.system,
      user: renderedPrompt.user,
      temperature: actualRoute.temperature,
      maxTokens: actualRoute.maxTokens
    }).then((rawMessage) => {
      const response = this.normalizeChatResponse(session.request, actualRoute, [...updatedSession.warnings, ...renderedPrompt.warnings], resumedObservations, rawMessage, startedAt, {
        pendingToolCalls: remainingToolCalls,
        resumedFromToolCallId: toolCallId,
        promptInputText: `${renderedPrompt.system}\n\n${renderedPrompt.user}`
      });
      response.retrieval = retrievalResolution?.metadata;
      const deltaToolCallIds = new Set(deltaObservations.map((item) => item.toolCallId).filter((item): item is string => Boolean(item)));
      response.observations = response.observations.filter(
        (observation) => observation.tool === 'safety' || (observation.toolCallId ? deltaToolCallIds.has(observation.toolCallId) : false)
      );
      response.summary = this.summarize(session.request, response.observations, [...updatedSession.warnings, ...renderedPrompt.warnings]);
      return response;
    });
  }

  async runChat(request: ChatTurnRequest): Promise<ChatTurnResponse> {
    const startedAt = Date.now();
    const prepared = await this.prepareChatTurn(request);

    if (prepared.cacheKey) {
      const cached = this.chatCache.get(prepared.cacheKey);
      if (cached) {
        const response = clone(cached.value);
        response.sessionId = request.sessionId;
        response.cache = { ...cached.metadata, hit: true };
        return response;
      }
    }

    const renderedPrompt = prepared.renderedPrompt || renderChatPrompt(this.promptTemplates, prepared.request, prepared.route, prepared.warnings, prepared.observations);
    const rawMessage = await this.adapter.completeChat({
      model: prepared.route.model,
      capability: prepared.route.capability,
      system: renderedPrompt.system,
      user: renderedPrompt.user,
      temperature: prepared.route.temperature,
      maxTokens: prepared.route.maxTokens
    });
    const response = this.normalizeChatResponse(prepared.request, prepared.route, prepared.warnings, prepared.observations, rawMessage, startedAt, {
      pendingToolCalls: prepared.pendingToolCalls,
      promptInputText: prepared.promptInputText
    });
    response.retrieval = prepared.retrieval;
    response.cache = prepared.cacheKey ? { scope: 'chat', key: prepared.cacheKey, hit: false } : undefined;

    if (prepared.pendingToolCalls.length > 0) {
      this.sessions.set(request.sessionId, {
        request: prepared.request,
        pendingToolCalls: prepared.pendingToolCalls,
        observations: response.observations,
        warnings: prepared.warnings
      });
    } else {
      this.sessions.delete(request.sessionId);
      if (prepared.cacheKey) {
        this.chatCache.set(prepared.cacheKey, clone(response));
      }
    }

    return response;
  }

  async streamChat(request: ChatTurnRequest, emit: (event: ChatStreamEvent) => Promise<void> | void): Promise<ChatTurnResponse> {
    const startedAt = Date.now();
    const prepared = await this.prepareChatTurn(request);

    if (prepared.cacheKey) {
      const cached = this.chatCache.get(prepared.cacheKey);
      if (cached) {
        const response = clone(cached.value);
        response.sessionId = request.sessionId;
        response.cache = { ...cached.metadata, hit: true };
        response.streaming = {
          transport: 'sse',
          path: this.streamingPath,
          firstEventLatencyMs: 0,
          completed: true
        };
        await emit({
          type: 'start',
          sessionId: request.sessionId,
          mode: request.mode,
          promptVersion: response.metrics?.promptVersion || prepared.route.promptVersion,
          cache: response.cache
        });
        if (response.message) {
          await emit({ type: 'message_delta', delta: response.message });
        }
        await emit({ type: 'final', response });
        await emit({ type: 'done' });
        return response;
      }
    }

    const renderedPrompt = prepared.renderedPrompt || renderChatPrompt(this.promptTemplates, prepared.request, prepared.route, prepared.warnings, prepared.observations);
    await emit({
      type: 'start',
      sessionId: request.sessionId,
      mode: request.mode,
      promptVersion: prepared.route.promptVersion,
      cache: prepared.cacheKey ? { scope: 'chat', key: prepared.cacheKey, hit: false } : undefined
    });

    let firstEventLatencyMs: number | undefined;
    let emittedLength = 0;
    const guardTailLength = 48;
    const observedStreamWarnings = new Set<string>();
    const emitFilteredProgress = async (rawText: string, flush = false): Promise<void> => {
      const filtered = filterOutputText(rawText);
      for (const warning of filtered.warnings) {
        observedStreamWarnings.add(warning);
      }
      const safeLimit = flush ? filtered.sanitizedText.length : Math.max(0, filtered.sanitizedText.length - guardTailLength);
      if (safeLimit <= emittedLength) {
        return;
      }
      const delta = filtered.sanitizedText.slice(emittedLength, safeLimit);
      emittedLength = safeLimit;
      if (!delta) {
        return;
      }
      if (firstEventLatencyMs === undefined) {
        firstEventLatencyMs = Date.now() - startedAt;
      }
      await emit({ type: 'message_delta', delta });
    };

    let rawMessage = '';
    if (this.adapter.streamChat) {
      rawMessage = await this.adapter.streamChat(
        {
          model: prepared.route.model,
          capability: prepared.route.capability,
          system: renderedPrompt.system,
          user: renderedPrompt.user,
          temperature: prepared.route.temperature,
          maxTokens: prepared.route.maxTokens
        },
        async (delta) => {
          rawMessage += delta;
          await emitFilteredProgress(rawMessage, false);
        }
      );
    } else {
      rawMessage = await this.adapter.completeChat({
        model: prepared.route.model,
        capability: prepared.route.capability,
        system: renderedPrompt.system,
        user: renderedPrompt.user,
        temperature: prepared.route.temperature,
        maxTokens: prepared.route.maxTokens
      });
      await emitFilteredProgress(rawMessage, true);
    }
    await emitFilteredProgress(rawMessage, true);

    const response = this.normalizeChatResponse(
      prepared.request,
      prepared.route,
      [...prepared.warnings, ...Array.from(observedStreamWarnings)],
      prepared.observations,
      rawMessage,
      startedAt,
      {
        pendingToolCalls: prepared.pendingToolCalls,
        cache: prepared.cacheKey ? { scope: 'chat', key: prepared.cacheKey, hit: false } : undefined,
        firstEventLatencyMs,
        promptInputText: prepared.promptInputText
      }
    );
    response.retrieval = prepared.retrieval;

    if (prepared.pendingToolCalls.length > 0) {
      this.sessions.set(request.sessionId, {
        request: prepared.request,
        pendingToolCalls: prepared.pendingToolCalls,
        observations: response.observations,
        warnings: prepared.warnings
      });
    } else {
      this.sessions.delete(request.sessionId);
      if (prepared.cacheKey) {
        this.chatCache.set(prepared.cacheKey, clone(response));
      }
    }

    await emit({ type: 'final', response });
    await emit({ type: 'done' });
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

    const response = await this.completePendingSession(session, toolCallId, approved, Date.now());
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
    const renderedPrompt = renderCompletionPrompt(this.promptTemplates, enrichedRequest, this.config.prompts.version);
    const model = this.config.models.completion || this.config.provider.model;
    const cacheKey = createCacheKey('completion', {
      cwd,
      request: enrichedRequest,
      model,
      promptVersion: renderedPrompt.templateVersion
    });
    const cached = this.completionCache.get(cacheKey);
    if (cached) {
      return {
        ...clone(cached.value),
        cache: {
          ...cached.metadata,
          hit: true
        }
      };
    }

    const suggestions = await this.adapter.completeInline({
      model,
      prompt: renderedPrompt.prompt,
      temperature: 0.15,
      maxTokens: 240
    });
    const text = suggestions.join('\n').trim();
    const metrics = buildUsageMetrics({
      startedAt,
      inputText: renderedPrompt.prompt,
      outputText: text,
      capability: 'completion',
      model,
      provider: this.adapter.id,
      promptVersion: renderedPrompt.templateVersion
    });
    const response: CompletionResponse = {
      items: suggestions
        .filter((entry) => entry.trim().length > 0)
        .map((entry) => ({
          text: entry,
          detail: `Generated by ${this.adapter.id} using ${model}`
        })),
      cache: {
        scope: 'completion',
        key: cacheKey,
        hit: false
      },
      metrics
    };
    this.completionCache.set(cacheKey, clone(response));
    return response;
  }

  async buildProjectIndex(cwd: string, force = false): Promise<ProjectIndexBuildResponse> {
    return this.semanticIndex.buildIndex(cwd, force);
  }

  async searchProjectIndex(request: ProjectSearchRequest): Promise<ProjectSearchResponse> {
    return this.semanticIndex.search(request);
  }
}
