import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';
import { CodeQualityBatchResultJSONSchema } from '../types/analysis-results.js';

export const codeQualityAnalyzer: AgentDefinition = {
  description: 'Use to review changed code for concrete security vulnerabilities, performance problems, correctness risks, and maintainability issues.',
  prompt: `${CODE_QUALITY_ANALYZER_PROMPT}

Return one result per supplied file in a JSON object with a "fileResults" array. Output must conform to this schema:
${JSON.stringify(CodeQualityBatchResultJSONSchema)}`,
  tools: ['Skill'],
  model: 'inherit'
};
