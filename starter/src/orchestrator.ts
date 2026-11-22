import { query } from '@anthropic-ai/claude-agent-sdk';

import { reviewSubagents } from './agents/index.js';
import { githubTools, mcpServersConfig } from './config/mcp.config.js';
import { buildOrchestratorPrompt } from './prompts/orchestrator.prompt.js';
import {
  ReviewReport,
  ReviewReportJSONSchema,
  ReviewReportSchema
} from './types/report-types.js';
import {
  ErrorCodes,
  RateLimiter,
  ReviewError,
  withRateLimit,
  withRetry
} from './utils/index.js';
import { logger } from './utils/logger.js';

const REQUIRED_AGENTS = [
  'code-quality-analyzer',
  'test-coverage-analyzer',
  'refactoring-suggester'
] as const;

const ORCHESTRATOR_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_MAX_TURNS = 60;
const ESTIMATED_TOKENS_PER_REVIEW = 30000;

interface ToolCall {
  toolName: string;
  toolUseId?: string;
  agentName?: string;
}

interface ToolFailure {
  toolName: string;
  toolUseId?: string;
  details: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getToolCalls(message: unknown): ToolCall[] {
  if (
    !isRecord(message) ||
    message.type !== 'assistant' ||
    !isRecord(message.message) ||
    !Array.isArray(message.message.content)
  ) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const block of message.message.content) {
    if (
      !isRecord(block) ||
      block.type !== 'tool_use' ||
      typeof block.name !== 'string'
    ) {
      continue;
    }

    const input = isRecord(block.input) ? block.input : {};
    toolCalls.push({
      toolName: block.name,
      agentName: block.name === 'Task' || block.name === 'Agent'
        ? typeof input.subagent_type === 'string'
          ? input.subagent_type
          : undefined
        : undefined,
      toolUseId: typeof block.id === 'string' ? block.id : undefined
    });
  }
  return toolCalls;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|API[_-]?KEY|AUTHORIZATION))\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function extractToolFailureDetails(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(isRecord)
    .map(block => typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n');
}

function getToolFailure(
  message: unknown,
  toolNames: Map<string, string>
): ToolFailure | undefined {
  if (
    !isRecord(message) ||
    message.type !== 'user' ||
    !isRecord(message.message) ||
    !Array.isArray(message.message.content)
  ) {
    return undefined;
  }

  for (const block of message.message.content) {
    if (!isRecord(block) || block.type !== 'tool_result' || block.is_error !== true) {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const details = redactSensitiveText(extractToolFailureDetails(block.content));
    return {
      toolName: toolUseId ? toolNames.get(toolUseId) ?? 'unknown tool' : 'unknown tool',
      toolUseId,
      details: details || 'Tool returned an error without additional details.'
    };
  }
  return undefined;
}

/**
 * Orchestrator configuration options.
 */
export interface OrchestratorOptions {
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Coordinates GitHub MCP retrieval, specialist agents, and report validation.
 */
export class CodeReviewOrchestrator {
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? ORCHESTRATOR_TIMEOUT_MS;
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    let attempt = 0;
    try {
      return await withRateLimit(
        this.rateLimiter,
        () => withRetry(
          () => this.runAttempt(owner, repo, prNumber, ++attempt),
          this.maxRetries,
          1000
        ),
        ESTIMATED_TOKENS_PER_REVIEW
      );
    } catch (error) {
      if (error instanceof ReviewError) throw error;

      throw new ReviewError(
        error instanceof Error ? error.message : 'Pull request review failed',
        ErrorCodes.AGENT_FAILED,
        { owner, repo, prNumber }
      );
    }
  }

  private async runAttempt(
    owner: string,
    repo: string,
    prNumber: number,
    attempt: number
  ): Promise<ReviewReport> {
    const controller = new AbortController();
    const startTime = Date.now();
    let timedOut = false;
    const context = { owner, repo, prNumber, attempt };
    logger.info('Review attempt started', { ...context, timeoutMs: this.timeoutMs });

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn('Review attempt timed out; cancelling SDK query', {
        ...context,
        elapsedMs: Date.now() - startTime
      });
      controller.abort();
    }, this.timeoutMs);

    try {
      const report = await this.runReview(owner, repo, prNumber, controller, attempt);
      if (timedOut) {
        throw new ReviewError(
          `Pull request review timed out after ${this.timeoutMs}ms`,
          ErrorCodes.AGENT_TIMEOUT
        );
      }
      logger.info('Review attempt completed', { ...context, elapsedMs: Date.now() - startTime });
      return report;
    } catch (error) {
      const failure = timedOut
        ? new ReviewError(
          `Pull request review timed out after ${this.timeoutMs}ms`,
          ErrorCodes.AGENT_TIMEOUT,
          { timeoutMs: this.timeoutMs, attempt }
        )
        : error;
      logger.warn('Review attempt failed', {
        ...context,
        elapsedMs: Date.now() - startTime,
        errorCode: failure instanceof ReviewError ? failure.code : ErrorCodes.UNKNOWN_ERROR
      });
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runReview(
    owner: string,
    repo: string,
    prNumber: number,
    abortController: AbortController,
    attempt: number
  ): Promise<ReviewReport> {
    const model = process.env.ANTHROPIC_MODEL;
    if (!model) {
      throw new ReviewError(
        'ANTHROPIC_MODEL is required',
        ErrorCodes.INVALID_CONFIG
      );
    }

    const startTime = Date.now();
    const invokedAgents = new Set<string>();
    const toolNames = new Map<string, string>();
    const toolStarts = new Map<string, { tool: string; agent?: string; startedAt: number }>();
    let structuredOutput: unknown;

    for await (const message of query({
      prompt: buildOrchestratorPrompt(owner, repo, prNumber),
      options: {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'Follow the coordinator instructions and return only the required structured report.'
        },
        agents: reviewSubagents,
        abortController,
        mcpServers: { github: mcpServersConfig.github },
        allowedTools: ['Task', 'Agent', 'Skill', ...githubTools],
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'],
        permissionMode: 'dontAsk',
        settingSources: ['project'],
        model,
        maxTurns: DEFAULT_MAX_TURNS,
        strictMcpConfig: true,
        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema
        }
      }
    })) {
      for (const toolCall of getToolCalls(message)) {
        if (toolCall.toolUseId) toolNames.set(toolCall.toolUseId, toolCall.toolName);
        if (toolCall.agentName) invokedAgents.add(toolCall.agentName);
        const tool = [...githubTools, 'Task', 'Agent', 'Skill'].includes(toolCall.toolName)
          ? toolCall.toolName : 'other';
        const agent = REQUIRED_AGENTS.find(name => name === toolCall.agentName);
        if (toolCall.toolUseId) {
          toolStarts.set(toolCall.toolUseId, { tool, agent, startedAt: Date.now() });
        }
        logger.info('Review tool started', {
          owner, repo, prNumber, attempt, tool, agent, elapsedMs: Date.now() - startTime
        });
      }

      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') continue;
          const started = toolStarts.get(block.tool_use_id);
          if (!started) continue;
          toolStarts.delete(block.tool_use_id);
          logger.info('Review tool completed', {
            owner, repo, prNumber, attempt,
            tool: started.tool,
            agent: started.agent,
            durationMs: Date.now() - started.startedAt,
            failed: block.is_error === true
          });
        }
      }

      const toolFailure = getToolFailure(message, toolNames);
      if (toolFailure) {
        throw new ReviewError(
          `${toolFailure.toolName} failed: ${toolFailure.details}`,
          ErrorCodes.ORCHESTRATION_FAILED,
          {
            owner,
            repo,
            prNumber,
            toolName: toolFailure.toolName,
            toolUseId: toolFailure.toolUseId
          }
        );
      }

      if (message.type !== 'result') continue;

      logger.info('Review query returned result', {
        owner, repo, prNumber, attempt, subtype: message.subtype, elapsedMs: Date.now() - startTime
      });
      if (message.subtype !== 'success') {
        throw new ReviewError(
          `Orchestrator query failed: ${message.subtype}`,
          ErrorCodes.AGENT_FAILED,
          { owner, repo, prNumber, subtype: message.subtype }
        );
      }

      if (message.permission_denials.length > 0) {
        throw new ReviewError(
          'The orchestrator was denied a required tool',
          ErrorCodes.ORCHESTRATION_FAILED,
          {
            owner,
            repo,
            prNumber,
            deniedTools: message.permission_denials.map(denial => denial.tool_name)
          }
        );
      }

      if (message.structured_output === undefined) {
        throw new ReviewError(
          'The orchestrator returned no structured report',
          ErrorCodes.STRUCTURED_OUTPUT_FAILED,
          { owner, repo, prNumber }
        );
      }

      structuredOutput = message.structured_output;
    }

    const missingAgents = REQUIRED_AGENTS.filter(agent => !invokedAgents.has(agent));
    if (missingAgents.length > 0) {
      throw new ReviewError(
        'The orchestrator did not invoke every required specialist agent',
        ErrorCodes.ORCHESTRATION_FAILED,
        { owner, repo, prNumber, missingAgents }
      );
    }

    if (structuredOutput === undefined) {
      throw new ReviewError(
        'The orchestrator query completed without a result',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { owner, repo, prNumber }
      );
    }

    return this.validateAndFinalizeReport(
      structuredOutput,
      owner,
      repo,
      prNumber,
      Date.now() - startTime
    );
  }

  private validateAndFinalizeReport(
    output: unknown,
    owner: string,
    repo: string,
    prNumber: number,
    duration: number
  ): ReviewReport {
    const parsed = ReviewReportSchema.safeParse(output);
    if (!parsed.success) {
      throw new ReviewError(
        'The orchestrator returned a report that did not match the required schema',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { issues: parsed.error.issues }
      );
    }

    const report = parsed.data;
    if (
      report.pullRequest.owner !== owner ||
      report.pullRequest.repo !== repo ||
      report.pullRequest.number !== prNumber
    ) {
      throw new ReviewError(
        'The orchestrator returned a report for a different pull request',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { owner, repo, prNumber, actualPullRequest: report.pullRequest }
      );
    }

    const files = report.fileReviews.map(fileReview => fileReview.file);
    if (
      new Set(files).size !== files.length ||
      report.fileReviews.some(fileReview =>
        fileReview.codeQuality.file !== fileReview.file ||
        fileReview.testCoverage.file !== fileReview.file ||
        fileReview.refactorings.file !== fileReview.file
      )
    ) {
      throw new ReviewError(
        'The report contains duplicate files or mismatched specialist results',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { files }
      );
    }

    const issues = report.fileReviews.flatMap(fileReview => fileReview.codeQuality.issues);
    const finalReport = ReviewReportSchema.safeParse({
      ...report,
      summary: {
        totalFiles: report.fileReviews.length,
        overallScore: Math.round(
          report.fileReviews.reduce(
            (total, fileReview) => total + fileReview.codeQuality.overallScore,
            0
          ) / report.fileReviews.length
        ),
        criticalIssues: issues.filter(issue => issue.severity === 'critical').length,
        highPriorityTests: report.fileReviews.reduce(
          (total, fileReview) => total + fileReview.testCoverage.untestedPaths.filter(
            path => path.priority === 'critical' || path.priority === 'high'
          ).length,
          0
        ),
        refactoringOpportunities: report.fileReviews.reduce(
          (total, fileReview) => total + fileReview.refactorings.suggestions.length,
          0
        )
      },
      recommendations: [
        ...report.fileReviews.flatMap(fileReview => fileReview.codeQuality.issues
          .filter(issue => issue.severity !== 'info')
          .map(issue => ({
            priority: issue.severity,
            category: issue.category,
            description: `${fileReview.file}:${issue.line} ${issue.description} Suggested fix: ${issue.suggestion}`,
            files: [fileReview.file]
          }))),
        ...report.fileReviews.flatMap(fileReview => fileReview.testCoverage.untestedPaths.map(path => ({
          priority: path.priority,
          category: 'test-coverage',
          description: `${fileReview.file} ${path.location}: ${path.reasoning} Suggested test: ${path.suggestedTest}`,
          files: [fileReview.file]
        }))),
        ...report.fileReviews.flatMap(fileReview => fileReview.refactorings.suggestions.map(suggestion => ({
          priority: suggestion.impact,
          category: `refactoring-${suggestion.type}`,
          description: `${fileReview.file} ${suggestion.location}: ${suggestion.description}`,
          files: [fileReview.file]
        })))
      ],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: {
          coordinator: 'claude-agent-sdk',
          ...Object.fromEntries(REQUIRED_AGENTS.map(name => [name, 'claude-agent-sdk-agent']))
        }
      }
    });

    if (!finalReport.success) {
      throw new ReviewError(
        'Unable to assemble a valid review report from the agent results',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { issues: finalReport.error.issues }
      );
    }

    return finalReport.data;
  }
}
