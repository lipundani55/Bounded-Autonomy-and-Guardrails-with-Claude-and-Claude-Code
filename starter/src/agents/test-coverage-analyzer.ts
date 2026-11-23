import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';
import { TestCoverageBatchResultJSONSchema } from '../types/analysis-results.js';

export const testCoverageAnalyzer: AgentDefinition = {
  description: 'Use to compare changed source behavior with available tests and identify specific, prioritized test gaps.',
  prompt: `${TEST_COVERAGE_ANALYZER_PROMPT}

Return one result per supplied file in a JSON object with a "fileResults" array. Output must conform to this schema:
${JSON.stringify(TestCoverageBatchResultJSONSchema)}`,
  tools: ['Skill'],
  model: 'inherit'
};
