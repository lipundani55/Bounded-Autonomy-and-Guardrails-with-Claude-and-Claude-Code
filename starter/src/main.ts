import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { formatError, ReviewError, ErrorCodes } from './utils/error-handler.js';
import { logReviewStart, logReviewComplete, logReviewError, logger } from './utils/logger.js';
import { ReportGenerator } from './utils/report-generator.js';

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev -- <owner> <repo> <pr-number>
 */
export async function main(): Promise<void> {
  const [ownerArg, repoArg, prStr] = process.argv.slice(2);
  const owner = ownerArg?.trim();
  const repo = repoArg?.trim();
  let prNumber: number | undefined;

  try {
    if (!owner || !repo || !prStr) {
      throw new ReviewError(
        'Usage: npm run dev -- <owner> <repo> <pr-number>',
        ErrorCodes.INVALID_CONFIG,
        { owner: ownerArg, repo: repoArg, prNumber: prStr }
      );
    }

    if (!/^\d+$/.test(prStr)) {
      throw new ReviewError(
        'PR number must be a positive integer',
        ErrorCodes.INVALID_CONFIG,
        { prNumber: prStr }
      );
    }

    prNumber = Number(prStr);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new ReviewError(
        'PR number must be a positive integer',
        ErrorCodes.INVALID_CONFIG,
        { prNumber: prStr }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    const awsRegion = process.env.AWS_REGION?.trim();
    const hasAwsCredentials = Boolean(awsAccessKeyId && awsSecretAccessKey);

    if (hasAwsCredentials && !awsRegion) {
      throw new ReviewError(
        'AWS_REGION is required when using AWS Bedrock. Set AWS_REGION (for example, us-east-1).',
        ErrorCodes.INVALID_CONFIG
      );
    }

    if (hasAwsCredentials) {
      logger.info('Using AWS Bedrock authentication');
    } else if (apiKey) {
      logger.info('Using Anthropic API authentication');
    } else if (awsAccessKeyId || awsSecretAccessKey) {
      throw new ReviewError(
        'AWS authentication is incomplete. Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, plus AWS_REGION.',
        ErrorCodes.MISSING_API_KEY
      );
    } else {
      throw new ReviewError(
        'No Claude authentication configured. Set ANTHROPIC_API_KEY, or set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION for Bedrock.',
        ErrorCodes.MISSING_API_KEY
      );
    }

    if (!process.env.ANTHROPIC_MODEL?.trim()) {
      throw new ReviewError(
        'ANTHROPIC_MODEL is required. Example for the Anthropic API: ANTHROPIC_MODEL=claude-sonnet-4-5-20250929. Example for Bedrock: ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0.',
        ErrorCodes.INVALID_CONFIG
      );
    }

    logReviewStart(owner, repo, prNumber);

    const orchestrator = new CodeReviewOrchestrator({
      maxRetries: 1
    });
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    const generator = new ReportGenerator();
    const projectRoot = process.env.PROJECT_ROOT?.trim() || process.cwd();
    const reportDir = resolve(projectRoot, 'reports');
    await mkdir(reportDir, { recursive: true });

    const baseName = `${owner}_${repo}_${prNumber}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const reportPaths = {
      markdown: resolve(reportDir, `${baseName}.md`),
      html: resolve(reportDir, `${baseName}.html`),
      json: resolve(reportDir, `${baseName}.json`)
    };

    await Promise.all([
      writeFile(reportPaths.markdown, generator.generateMarkdownReport(report), 'utf8'),
      writeFile(reportPaths.html, generator.generateHTMLReport(report), 'utf8'),
      writeFile(reportPaths.json, generator.generateJSONReport(report), 'utf8')
    ]);

    logReviewComplete(owner, repo, prNumber, report.summary.overallScore, report.metadata.duration);
    logger.info('All report formats saved', reportPaths);
    console.log(`Markdown report saved: ${reportPaths.markdown}`);
    console.log(`HTML report saved: ${reportPaths.html}`);
    console.log(`JSON report saved: ${reportPaths.json}`);
  } catch (error) {
    if (owner && repo && prNumber) {
      logReviewError(owner, repo, prNumber, error instanceof Error ? error : new Error(String(error)));
    } else {
      logger.error('CLI validation failed', { error: formatError(error) });
    }

    console.error(formatError(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
