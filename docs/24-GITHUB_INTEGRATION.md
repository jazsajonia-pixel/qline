# 24 · GitHub integration (v1.10)

v1.6 connected GitHub for issues only. v1.10 lets the AI work with code: browse repositories, read and search files, follow branches, commits and pull requests, inspect CI, and — only after a person approves a diff — create working branches, commit files and open, edit or comment-review pull requests.

## 1. What changed

| Area | v1.6 | v1.10 |
|---|---|---|
| Read | repos, issues/PRs list, one issue/PR | + repository facts, folder tree, file contents (paged, redacted), code search, branches, commits, compare, PR files/reviews/checks, Actions runs, jobs and failed-log tail, check runs and statuses |
| Write (approval) | open issue, comment | + create branch, commit files to a working branch, open PR, edit PR, review PR (comment / request changes) |
| App screen | — | **Integrations → GitHub → Code, pull requests and CI**: capabilities, repositories, code, branches, commits, PRs, CI |
| Approvals | text preview | + a unified diff for every code or PR-text change |

## 2. GitHub App permissions

Qline uses a GitHub App with expiring user tokens. The token can only do what **both** the app's permissions and the signed-in user allow, and only in repositories where the app is installed.

| Permission | Level | Used for |
|---|---|---|
| Metadata | Read | Required by GitHub |
| Contents | Read and write | Read code and history; create branches and commit files (writes only with approval) |
| Pull requests | Read and write | Read PRs; open, edit and comment-review PRs (writes only with approval) |
| Issues | Read and write | Read issues; open issues and comment (approval) |
| Actions | Read | Workflow runs, jobs, logs |
| Checks | Read | Check runs on a commit |
| Commit statuses | Read | Legacy statuses on a commit |
| Workflows, Secrets, Administration, Environments, Variables | **No access** | Never used. If granted, the capabilities screen warns about them |

Missing permissions are not fatal: each feature that needs one says which (`GET /v1/github/capabilities`), and a 403 "Resource not accessible by integration" from GitHub is turned into "the Qline GitHub App needs the X permission". Permission changes on an existing app must be accepted per installation on GitHub.

OAuth is unchanged (`services/api/src/integrations/oauth.ts`): GitHub Apps ignore OAuth scopes, so least privilege lives in the app's permissions and installation repository selection, not in Qline.

## 3. Agent tools

Reads are L0 (`tasks.read`, every agent template that already had `github.repos`):
`github.repo`, `github.tree`, `github.file`, `github.code_search`, `github.branches`, `github.commits`, `github.commit`, `github.compare`, `github.pulls`, `github.pull`, `github.runs`, `github.run`, `github.checks`.

Writes are L3, `require_approval`, `tasks.write`, CEO and Operations templates only:

| Tool | Does | Refuses |
|---|---|---|
| `github.branch.create` | New branch from a base branch or SHA | Existing names, invalid names |
| `github.files.commit` | One commit of up to 10 files (full new contents) to a working branch, optionally creating it (`createFrom`) | Default branch, protected branches, `.github/workflows`, `.github/actions`, `.env*`, keys/certificates, `key.properties`; content containing `[redacted]`; diffs over 2,000 lines; file modes are kept |
| `github.pr.create` | Opens a PR (draft allowed); `maintainer_can_modify` is off | Head = base, head = default branch |
| `github.pr.update` | Title, body, draft→ready, base | Closing/merging |
| `github.pr.review` | `COMMENT` or `REQUEST_CHANGES`, with inline comments | `APPROVE` (an AI approval could satisfy branch protection and enable a merge nobody reviewed) |

Existing `github.issue.create` and `github.issue.comment` are unchanged in behaviour but are now in `ALWAYS_ASK`.

Not implemented on purpose: merge, force-push, branch or file deletion, workflow edits, workflow dispatch/re-run, secrets, repository settings.

## 4. Approval, staging and pinning

1. The model calls a write tool. The runner builds the preview; the tool's `stage()` then reads GitHub: current branch head, default branch, protected flag, current file contents.
2. `stage()` builds a unified diff (3 lines of context) and pins what it saw in `_pinned` (head SHA, file SHAs/modes, PR head). If staging fails (protected branch, blocked path, too large), nothing is recorded and the model gets the reason.
3. The approval card shows title, lines, **Changes** (the diff), and the exact inputs with file contents replaced by "[N characters, shown in the diff]".
4. On approve, execute re-checks: default branch, protected status and that the branch head still equals the pinned SHA. If anything moved, it fails and asks for a fresh request. A call without a server-written `_pinned` fails `NOT_STAGED`, so a forged or replayed call cannot skip the diff.
5. Commits go blobs → tree (with `base_tree`) → commit → `PATCH refs/heads/<branch>` with `force: false`, so GitHub itself refuses anything that is not a fast-forward.

Every GitHub write is in `EXTERNAL_WRITE_TOOLS` and `ALWAYS_ASK` (`packages/policy`), so **full autopilot cannot auto-run them**. Behaviour change: in v1.6–1.9 full autopilot could auto-run `github.issue.create`/`issue.comment`; now they always ask.

Audit events: `github.branch_created`, `github.files_committed`, `github.pr_created`, `github.pr_updated`, `github.pr_reviewed` (repo, branch/PR, SHAs, file paths; never file contents).

## 5. Secrets

- File reads, code-search fragments, patches and CI log tails pass through `redactSecrets` (PEM private keys; GitHub, Slack, Stripe, AWS access-key, Google API/OAuth, OpenAI-style `sk-` and npm tokens). GitHub Actions already masks registered secrets in logs; generic `password=` style assignments are not detected → `[redacted]`.
- Writes refuse content containing `[redacted]`, so a redacted value can't be written back over the real one.
- Qline never calls the Secrets, Variables or Environments APIs, and does not change workflows (a workflow can read repository secrets).
- Files over 1 MB and binary files are not read.

## 6. Routes

Read-only routes for the app screen are listed in [docs/06 §7](06-API_AND_EVENTS.md). They need `tasks.read` and only use the caller's organization's connection (row-level security on `connections`).

## 7. Tenant isolation

Tokens are per-organization connections, encrypted at rest and read inside the tenant transaction. Tests cover: a second organization gets 409 `GITHUB_NOT_CONNECTED`, and a viewer cannot approve a GitHub write.

## 8. Data model

Migration `0025_github_code.sql` adds the new read tools to built-in agents' current versions where `github.repos` is already allowed, and the write tools to CEO/Operations versions that already have `github.issue.create`. No new tables.

## 9. Verification

See the v1.10.0 release notes and the PR for the evidence of this run. Summary:

- Unit and integration tests against a fake GitHub (`services/api/test/github-code.integration.test.ts`, `unit.test.ts`): staging, pinning, forged `_pinned` under full autopilot, refusal paths, diff, redaction, routes, isolation, viewer 403.
- The REST layer (`integrations/github.ts`) was exercised against real GitHub on a private scratch repository: tree, file, branch create, multi-file commit keeping mode 100755, non-fast-forward refusal (422), draft PR create and edit, comment review with an inline comment, check runs, workflow runs, run detail with a masked failed-log tail.
- Code search returns nothing for brand-new repositories until GitHub indexes them.
- Production rollout (2026-11-20): migration 0025 applied (60 built-in agent versions gained the read tools, 20 CEO/Operations versions the approval-gated write tools; finance, research, marketing, sales and custom agents got no write tools), then API 1.10.0 deployed as Neon function deployment #16. `/v1/health` reports 1.10.0 and `/v1/health/ready` is ok. Rollback: redeploy deployment #15 (0025 only adds tool names, which 1.9.0 ignores).
- Not yet verified: the tools in the app with the Qline GitHub App's own user token, and on a real phone.
