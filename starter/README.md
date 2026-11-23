# Multi-Agent Code Review Orchestrator

Review GitHub pull requests with the Claude Agent SDK. The orchestrator retrieves
PR metadata and patches, delegates analysis to three specialists, validates the
structured result, and saves Markdown, HTML, and JSON reports.

## How it works

- **Code quality analyzer:** identifies evidence-backed correctness, security,
  performance, maintainability, and style issues.
- **Test coverage analyzer:** identifies test gaps from the supplied patches.
  Coverage is an estimate, not a measured result.
- **Refactoring suggester:** proposes focused improvements to changed code.

Each specialist has access to the `Skill` tool. Their prompts select the
language-independent `code-review` skill for code and `documentation-review`
for documentation. Skills are guidance and their invocation depends on the
agent; they do not execute or test the PR code.

The orchestrator uses Zod schemas to validate reports, checks that all three
specialists were invoked, and includes retry, timeout, and rate-limit handling.
Reviews are based on the PR data available to the agents; missing context can
limit findings.

## Requirements

- Node.js compatible with the installed ESLint MCP server: Node 20.19 or later
  in the 20.x series, Node 22.13 or later in the 22.x series, or Node 24+.
  The package's general Node requirement is 18+, but the ESLint MCP
  dependency has the stricter requirement.
- Anthropic API credentials or AWS Bedrock credentials, and a model available
  to your account.
- A GitHub token is recommended for higher rate limits and required for private
  repositories the token must be permitted to access.

## Setup

From this directory:

```powershell
npm install
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead. Edit `.env` or set the
following environment variables:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_MODEL` | Required model identifier. |
| `ANTHROPIC_API_KEY` | Anthropic API authentication, unless using Bedrock. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | AWS credentials and region for Bedrock. The CLI requires all three if using AWS credentials. |
| `CLAUDE_CODE_USE_BEDROCK` | Set to `1` when using Bedrock with the Claude Agent SDK. |
| `GITHUB_TOKEN` | Recommended GitHub token; mapped to the GitHub MCP server's `GITHUB_PERSONAL_ACCESS_TOKEN`. |
| `PROJECT_ROOT` | Optional report output root; defaults to the current working directory. |
| `LOG_LEVEL` | Optional Winston logging level, such as `info` or `debug`. |

For example, configure Anthropic API authentication with:

```dotenv
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
GITHUB_TOKEN=your-github-token
```

Keep credentials out of version control. The supplied `.env.example` contains
a Vocareum-specific `PROJECT_ROOT`; replace it with your own absolute path or
remove it to use the current directory. Run the application from this project
directory so the SDK can discover its project skills in `.claude/skills/`.
`PROJECT_ROOT` controls report output; it does not change the SDK working
directory.

## Run a review

```powershell
npm run dev -- <owner> <repo> <pr-number>
```

For example:

```powershell
npm run dev -- octocat Hello-World 1
```

Alternatively, run `npm run build` followed by
`npm start -- <owner> <repo> <pr-number>`. The PR number must be a positive
integer. On Windows, use `npm.cmd` instead of `npm` if PowerShell blocks
`npm.ps1`.

On success, the application writes these files under `PROJECT_ROOT/reports/`
(or `reports/` in the current directory when `PROJECT_ROOT` is unset):

```text
<owner>_<repo>_<pr-number>.md
<owner>_<repo>_<pr-number>.html
<owner>_<repo>_<pr-number>.json
```

Running the same review again overwrites files with the same names. The CLI
prints their full paths. Logs are written to `logs/` in the working directory.

## MCP tools and limitations

The GitHub MCP server supplies PR metadata and changed-file patches. The
orchestrator also registers the ESLint MCP server and allows its `lint-files`
tool. That tool requires absolute paths to local files; the current review
workflow passes remote PR patches to agents and does **not** check out the PR
or provide those local files. Registering the tool therefore does not mean
ESLint ran on the PR. The agents' findings are based on their analysis of the
available data unless actual lint results are supplied.

## Validation

```powershell
npm test
npm run build
npm run lint
```

To run the orchestrator tests alone, use
`npm test -- tests/orchestrator.test.ts`. These tests mock the Claude SDK and
do not replace a live PR review.

## Project layout

- `src/agents/` and `src/prompts/`: specialist definitions and instructions.
- `src/orchestrator.ts`: SDK orchestration and report validation.
- `src/config/`: MCP server and tool configuration.
- `src/types/`: Zod schemas for analysis and reports.
- `src/utils/`: logging, reliability, rate limiting, and report generation.
- `.claude/skills/`: project skills available to agents.
- `tests/`: orchestrator, reliability, and schema tests.

## Resources

- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [ESLint MCP setup](https://eslint.org/docs/latest/use/mcp)
- [Zod](https://zod.dev/)
