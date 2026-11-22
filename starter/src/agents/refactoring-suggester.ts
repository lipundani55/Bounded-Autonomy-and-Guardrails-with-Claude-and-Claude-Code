import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';
import { RefactoringBatchResultJSONSchema } from '../types/analysis-results.js';

export const refactoringSuggester: AgentDefinition = {
  description: 'Use to identify focused, safe refactoring and modernization opportunities justified by changed code.',
  prompt: `${REFACTORING_SUGGESTER_PROMPT}

Return one result per supplied file in a JSON object with a "fileResults" array. Output must conform to this schema:
${JSON.stringify(RefactoringBatchResultJSONSchema)}`,
  tools: [],
  model: 'inherit'
};
