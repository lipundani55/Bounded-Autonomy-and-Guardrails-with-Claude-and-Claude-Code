import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  CodeQualityResultSchema,
  RefactoringSuggestionSchema,
  TestCoverageResultSchema
} from '../src/types/analysis-results.js';
import {
  CodeQualityResultJSONSchema,
  RefactoringSuggestionJSONSchema,
  TestCoverageResultJSONSchema
} from '../src/types/analysis-results.js';
import {
  ReviewReportJSONSchema,
  ReviewReportSchema
} from '../src/types/report-types.js';

function validCodeQualityResult(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/example.ts',
    issues: [],
    overallScore: 85,
    summary: 'No significant issues found.',
    ...overrides
  };
}

function validTestCoverageResult(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/example.ts',
    hasTests: true,
    testFiles: ['tests/example.test.ts'],
    untestedPaths: [],
    coverageEstimate: 80,
    summary: 'Most paths have coverage.',
    ...overrides
  };
}

function validRefactoringResult(overrides: Record<string, unknown> = {}) {
  return {
    file: 'src/example.ts',
    suggestions: [],
    summary: 'No refactoring required.',
    ...overrides
  };
}

function validReviewReport(overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      owner: 'octocat',
      repo: 'Hello-World',
      number: 1
    },
    fileReviews: [{
      file: 'src/example.ts',
      codeQuality: validCodeQualityResult(),
      testCoverage: validTestCoverageResult(),
      refactorings: validRefactoringResult()
    }],
    summary: {
      totalFiles: 1,
      overallScore: 85,
      criticalIssues: 0,
      highPriorityTests: 0,
      refactoringOpportunities: 0
    },
    recommendations: [],
    metadata: {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      duration: 1000,
      agentVersions: {}
    },
    ...overrides
  };
}

describe('Zod schemas', () => {
  it('accepts valid data for every exported result schema', () => {
    expect(() => CodeQualityResultSchema.parse(validCodeQualityResult())).not.toThrow();
    expect(() => TestCoverageResultSchema.parse(validTestCoverageResult())).not.toThrow();
    expect(() => RefactoringSuggestionSchema.parse(validRefactoringResult())).not.toThrow();
    expect(() => ReviewReportSchema.parse(validReviewReport())).not.toThrow();
  });

  it('rejects invalid types, missing required data, and invalid enum values', () => {
    expect(() => CodeQualityResultSchema.parse({
      ...validCodeQualityResult(),
      overallScore: '85'
    })).toThrow(ZodError);

    expect(() => TestCoverageResultSchema.parse({
      file: 'src/example.ts'
    })).toThrow(ZodError);

    expect(() => RefactoringSuggestionSchema.parse(validRefactoringResult({
      suggestions: [{
        type: 'rewrite-everything',
        location: 'line 1',
        impact: 'high',
        description: 'Invalid enum value',
        before: 'old',
        after: 'new',
        benefits: 'none'
      }]
    }))).toThrow(ZodError);

    expect(() => ReviewReportSchema.parse(validReviewReport({
      metadata: undefined
    }))).toThrow(ZodError);
  });

  it('accepts empty finding arrays and score boundaries while enforcing report files', () => {
    expect(CodeQualityResultSchema.parse(validCodeQualityResult({
      overallScore: 0,
      issues: []
    })).overallScore).toBe(0);
    expect(CodeQualityResultSchema.parse(validCodeQualityResult({
      overallScore: 100
    })).overallScore).toBe(100);

    expect(TestCoverageResultSchema.parse(validTestCoverageResult({
      coverageEstimate: 0,
      testFiles: [],
      untestedPaths: []
    })).coverageEstimate).toBe(0);
    expect(TestCoverageResultSchema.parse(validTestCoverageResult({
      coverageEstimate: 100
    })).coverageEstimate).toBe(100);

    expect(RefactoringSuggestionSchema.parse(validRefactoringResult({
      suggestions: []
    })).suggestions).toEqual([]);
    expect(() => ReviewReportSchema.parse(validReviewReport({
      fileReviews: []
    }))).toThrow(ZodError);
  });

  it('exports JSON Schemas with valid object structure and required properties', () => {
    const schemaCases = [
      {
        schema: CodeQualityResultJSONSchema,
        required: ['file', 'issues', 'overallScore', 'summary']
      },
      {
        schema: TestCoverageResultJSONSchema,
        required: ['file', 'hasTests', 'testFiles', 'untestedPaths', 'coverageEstimate', 'summary']
      },
      {
        schema: RefactoringSuggestionJSONSchema,
        required: ['file', 'suggestions', 'summary']
      },
      {
        schema: ReviewReportJSONSchema,
        required: ['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata']
      }
    ];

    for (const { schema, required } of schemaCases) {
      expect(schema).toMatchObject({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: expect.any(Object)
      });
      expect(schema.required).toEqual(required);
    }
  });
});
