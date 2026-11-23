import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { reviewSubagents } from '../src/agents/index.js';
import { eslintTools, githubTools, mcpServersConfig } from '../src/config/mcp.config.js';
import { CodeReviewOrchestrator } from '../src/orchestrator.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';
import { logger } from '../src/utils/logger.js';
import { ReviewReport } from '../src/types/report-types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}));

const agentNames = [
  'code-quality-analyzer',
  'test-coverage-analyzer',
  'refactoring-suggester'
];

const validReport: ReviewReport = {
  pullRequest: { owner: 'octocat', repo: 'hello-world', number: 123 },
  fileReviews: [{
    file: 'src/example.ts',
    codeQuality: {
      file: 'src/example.ts',
      issues: [{
        line: 2,
        severity: 'critical',
        category: 'security',
        description: 'Untrusted input reaches a shell command.',
        suggestion: 'Pass arguments without shell interpolation.'
      }],
      overallScore: 80,
      summary: 'One critical issue'
    },
    testCoverage: {
      file: 'src/example.ts',
      hasTests: true,
      testFiles: ['tests/example.test.ts'],
      untestedPaths: [{
        type: 'branch',
        location: 'runCommand() error branch',
        priority: 'high',
        reasoning: 'The failure branch determines whether command errors are surfaced.',
        suggestedTest: 'Mock a failed command and assert the error is propagated.'
      }],
      coverageEstimate: 80,
      summary: 'One high-priority gap'
    },
    refactorings: {
      file: 'src/example.ts',
      suggestions: [{
        type: 'extract-function',
        location: 'runCommand()',
        impact: 'medium',
        description: 'Separate command construction from execution.',
        before: 'runCommand() validates input and invokes the shell inline.',
        after: 'buildCommand() validates and returns the command arguments.',
        benefits: 'Makes command construction independently testable.'
      }],
      summary: 'One focused refactoring'
    }
  }],
  summary: {
    totalFiles: 1,
    overallScore: 90,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 0
  },
  recommendations: [],
  metadata: {
    analyzedAt: '2026-11-22T00:00:00.000Z',
    duration: 1,
    agentVersions: { coordinator: 'test' }
  }
};

function mockSuccessfulQuery(options: {
  output?: unknown;
  invokedAgents?: string[];
  toolFailure?: boolean;
  toolError?: string;
} = {}): void {
  const invokedAgents = options.invokedAgents ?? agentNames;

  const response = async function* () {
    for (const agentName of invokedAgents) {
      yield {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: `tool-${agentName}`,
            name: 'Task',
            input: { subagent_type: agentName }
          }]
        }
      } as never;
    }

    if (options.toolFailure) {
      yield {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-code-quality-analyzer',
            is_error: true,
            content: options.toolError ?? 'Agent failed'
          }]
        }
      } as never;
    }

    yield {
      type: 'result',
      subtype: 'success',
      permission_denials: [],
      structured_output: options.output === undefined ? validReport : options.output
    } as never;
  };

  vi.mocked(query).mockImplementation((() => response()) as never);
}

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-test-model');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('configuration', () => {
    it('accepts custom rate-limit configuration', () => {
      const limiter = new RateLimiter({
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 5000,
        maxConcurrent: 2
      });
      const orchestrator = new CodeReviewOrchestrator({ rateLimiter: limiter });

      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
      expect(limiter.getStatus().availableRequests).toBe(10);
      expect(limiter.getStatus().availableTokens).toBe(5000);
    });
  });

  describe('reviewPullRequest', () => {
    it('passes MCP tools, specialist definitions, and the configured model to query', async () => {
      mockSuccessfulQuery();

      const orchestrator = new CodeReviewOrchestrator();
      await orchestrator.reviewPullRequest('octocat', 'hello-world', 123);

      expect(query).toHaveBeenCalledTimes(1);
      const input = vi.mocked(query).mock.calls[0]![0] as unknown as {
        prompt: string;
        options: {
          agents: Record<string, { tools?: string[]; prompt: string }>;
          allowedTools: string[];
          mcpServers: Record<string, unknown>;
          model: string;
          maxTurns: number;
          permissionMode: string;
          outputFormat: { type: string; schema: Record<string, unknown> };
        };
      };

      expect(input.prompt).toContain('octocat/hello-world#123');
      expect(Object.keys(input.options.agents)).toEqual(agentNames);
      expect(input.options.agents['code-quality-analyzer']?.tools).toEqual(['Skill']);
      expect(input.options.agents['test-coverage-analyzer']?.tools).toEqual(['Skill']);
      expect(input.options.agents['refactoring-suggester']?.tools).toEqual(['Skill']);
      for (const agentName of agentNames) {
        expect(input.options.agents[agentName]?.prompt).toContain('"code-review"');
        expect(input.options.agents[agentName]?.prompt).toContain('"documentation-review"');
      }
      expect(input.options.allowedTools).toContain('Task');
      expect(input.options.allowedTools).toContain('Agent');
      expect(input.options.allowedTools).toContain('Skill');
      expect(input.options.allowedTools).toEqual(expect.arrayContaining(githubTools));
      expect(input.options.allowedTools).toEqual(expect.arrayContaining(eslintTools));
      expect(input.options.mcpServers.github).toEqual(mcpServersConfig.github);
      expect(input.options.mcpServers.eslint).toEqual(mcpServersConfig.eslint);
      expect(input.options.model).toBe('claude-test-model');
      expect(input.options.maxTurns).toBe(60);
      expect(input.options.permissionMode).toBe('dontAsk');
      expect(input.options.outputFormat.type).toBe('json_schema');
      expect(input.options.outputFormat.schema).toBeDefined();
    });

    it('uses the configured review token estimate and default timeout', async () => {
      mockSuccessfulQuery();
      const log = vi.spyOn(logger, 'info');
      const limiter = new RateLimiter({ maxTokensPerMinute: 30000 });

      await new CodeReviewOrchestrator({ rateLimiter: limiter })
        .reviewPullRequest('octocat', 'hello-world', 123);

      expect(limiter.getStatus().availableTokens).toBe(0);
      expect(log).toHaveBeenCalledWith(
        'Review attempt started',
        expect.objectContaining({ timeoutMs: 480000 })
      );
    });

    it('validates the structured report and calculates summary metrics', async () => {
      mockSuccessfulQuery();

      const orchestrator = new CodeReviewOrchestrator();
      const report = await orchestrator.reviewPullRequest('octocat', 'hello-world', 123);

      expect(report.pullRequest).toEqual(validReport.pullRequest);
      expect(report.summary).toEqual({
        totalFiles: 1,
        overallScore: 80,
        criticalIssues: 1,
        highPriorityTests: 1,
        refactoringOpportunities: 1
      });
      expect(report.recommendations).toHaveLength(3);
      expect(report.metadata.agentVersions).toHaveProperty('code-quality-analyzer');
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('rejects a response when a specialist agent was not invoked', async () => {
      mockSuccessfulQuery({ invokedAgents: agentNames.slice(0, 2) });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 123)
      ).rejects.toMatchObject({ code: 'ORCHESTRATION_FAILED' });
    });

    it('surfaces the failing tool and sanitized cause instead of returning a report', async () => {
      const secret = 'ghp_123456789012345678901234567890';
      mockSuccessfulQuery({
        toolFailure: true,
        toolError: `Agent failed: Authorization: Bearer ${secret}`
      });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
      const error = await orchestrator
        .reviewPullRequest('octocat', 'hello-world', 123)
        .catch(reason => reason);

      expect(error).toMatchObject({
        code: 'ORCHESTRATION_FAILED',
        metadata: { toolName: 'Task' }
      });
      expect(error.message).toContain('Task failed: Agent failed');
      expect(error.message).toContain('[REDACTED]');
      expect(error.message).not.toContain(secret);
    });

    it('rejects output that does not match the ReviewReport schema', async () => {
      mockSuccessfulQuery({ output: { ...validReport, fileReviews: [] } });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 123)
      ).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_FAILED' });
    });

    it('rejects reports for a different pull request', async () => {
      mockSuccessfulQuery({
        output: {
          ...validReport,
          pullRequest: { owner: 'other', repo: 'repo', number: 4 }
        }
      });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 0 });
      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 123)
      ).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_FAILED' });
    });

    it('aborts timed-out SDK queries and waits for cleanup before retrying', async () => {
      const events: string[] = [];
      vi.mocked(query).mockImplementation((params => {
        const controller = params.options?.abortController;
        if (!controller) throw new Error('Abort controller missing');
        const attempt = events.filter(event => event === 'started').length + 1;
        events.push('started');
        return (async function* () {
          await new Promise<void>(resolve => {
            controller.signal.addEventListener('abort', () => {
              events.push(`aborted-${attempt}`);
              setTimeout(() => {
                events.push(`cleaned-${attempt}`);
                resolve();
              }, 10);
            }, { once: true });
          });
        })() as never;
      }) as typeof query);

      const orchestrator = new CodeReviewOrchestrator({ timeoutMs: 5, maxRetries: 1 });
      await expect(
        orchestrator.reviewPullRequest('octocat', 'hello-world', 123)
      ).rejects.toMatchObject({
        code: 'RETRY_EXHAUSTED',
        message: expect.stringContaining('[AGENT_TIMEOUT]')
      });

      expect(events).toEqual([
        'started', 'aborted-1', 'cleaned-1',
        'started', 'aborted-2', 'cleaned-2'
      ]);
    });

    it('logs specialist invocation timing without logging tool inputs', async () => {
      const log = vi.spyOn(logger, 'info');
      mockSuccessfulQuery();

      await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'hello-world', 123);

      expect(log).toHaveBeenCalledWith(
        'Review tool started',
        expect.objectContaining({ tool: 'Task', agent: 'code-quality-analyzer', attempt: 1 })
      );
      expect(log).toHaveBeenCalledWith(
        'Review query returned result',
        expect.objectContaining({ subtype: 'success', elapsedMs: expect.any(Number) })
      );
    });
  });
});
