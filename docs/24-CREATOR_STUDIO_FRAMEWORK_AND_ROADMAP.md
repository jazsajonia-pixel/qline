# 24 — Creator Studio: reusable framework, workflow contract and completion roadmap

**Status:** Product specification and roadmap; implementation is partial.  
**Prepared:** 2026-11-20  
**Baseline:** Qline v1.9.0, main `3ece71d7501c1615ca9db9075f7d7071732cec84`.

This document makes Qline's creator workflow a first-class, reusable product capability. It captures the repeatable framework behind the owner's current content-creation workflow without copying the owner's private accounts, files, preferences, folder IDs or credentials into other users' workspaces.

## 1. Product outcome

Any Qline user should be able to ask naturally for help creating, producing and publishing content. Qline should understand the complete task, guide the user through only the setup and approvals that task needs, and coordinate the remaining steps through completion.

Example request:

> "Draft a video prompt for a short product video using my footage."

Qline should:
1. Recognize this as a creator workflow, not merely a text-generation request.
2. Check whether the user has completed a Creator Profile and whether the requested task needs source footage, reference images, saved exports or an editor handoff.
3. If Drive is needed and not connected, explain the exact purpose and request the user's approval to connect their own Google account with the minimum required scopes.
4. If the user has not selected a content folder, offer to create the standard Qline folder template in their Drive or let them map existing folders. Show the exact proposed structure and ask before creating anything.
5. Read only the approved root and mapped folders; index assets within the configured boundary.
6. Draft the prompt using the user's selected assets and Creator Profile. Show the prompt and assumptions for review.
7. Offer the next useful step (save, storyboard, editor handoff, render QA or platform package) without silently performing it.

A generic prompt that uses no private assets and needs no storage should still work without forcing a Drive connection. Integration checks are task-aware, not a blanket OAuth wall.

## 2. Reusable defaults vs. private user data

Qline must separate its product blueprint from each user's private Creator Studio instance.

### Shared, product-owned blueprint

Ship versioned defaults that every user can start from:
- Creator Studio workflow definitions and state transitions.
- Default role/agent playbooks and tool allowlists.
- Creator Profile schema and onboarding questions.
- Standard Drive folder template.
- Content brief, script, storyboard, shot list, video prompt, QA and platform-post templates.
- Platform capability definitions and approval rules.
- Prompt quality rubric and content QA checklists.
- Setup/readiness checks, safe recovery paths and help text.

Blueprint updates must be versioned and must not silently overwrite a user's customized profile, folder mapping, saved templates or agent instructions.

### Tenant-owned configuration and data

Each user/workspace owns its:
- Creator Profile, audience, niche, goals, language, tone, content pillars, brand kit, posting cadence and constraints.
- Connected Drive and social accounts, OAuth grants and provider-specific account IDs.
- Drive root and folder IDs, folder mappings and asset index.
- Content ideas, research, briefs, scripts, prompts, renders, captions, approvals, schedules, posts and analytics.
- Custom agents, overrides, knowledge and audit history.

Never seed one user's account identifiers, folder IDs, tokens, brand assets, files, history or private preferences into another user's account. Copy only generic templates and public product defaults.

## 3. Creator Profile and onboarding

Provide a reusable Creator Profile that users can complete gradually. Ask only for fields relevant to the current task; allow skip/unknown values and progressive completion.

Suggested fields:
- Creator or brand name and short description.
- Niche, audience, audience needs and primary goals.
- Content pillars and recurring series.
- Preferred language(s), tone, vocabulary and regional conventions.
- Platforms and account targets.
- Visual identity: palette, typography, logo/brand assets and reference links.
- Video preferences: formats, aspect ratios, typical duration, pacing, narration, subtitles and accessibility.
- Content boundaries: topics to avoid, factuality requirements, claims requiring evidence, rights/consent constraints.
- Publishing cadence, timezone and preferred windows.
- Workflow preferences: manual vs. assisted stages, editor choice, review gates and notification preferences.

The profile is editable, versioned and scoped to a personal or business workspace. A user's explicit instruction for a single task may override a default for that task without rewriting the persistent profile.

## 4. Intent routing and integration readiness

Every creator request should be classified into a workflow intent, for example:
- idea/research;
- content brief;
- script;
- storyboard/scene plan;
- AI-video prompt;
- asset search/selection;
- external editor handoff;
- render review/QA;
- platform caption/package;
- schedule/publish;
- analytics/community follow-up.

Before executing, build a task-specific dependency checklist. Do not ask for unrelated integrations.

| Task | Drive requirement | Social account requirement | Other requirements |
|---|---|---|---|
| Generic prompt from text only | No | No | Creator Profile optional |
| Prompt based on user's footage/brand assets | Yes, if assets are in Drive | No | Approved folder boundary |
| Save brief, prompt or export to Drive | Yes | No | Explicit save/creation approval |
| External editor handoff | Yes | No | User selects editor and approves which assets are shared |
| Draft platform-specific captions | No, unless using stored assets/context | Platform selection helps; account connection not required for drafting | Platform rules/capabilities |
| Schedule or publish | Media must be accessible to the publishing workflow; Drive may be the source | Yes, for each target account | Exact media/copy/targets/time approval |
| Analytics/community monitoring | No, unless user asks to inspect stored reports | Yes, for supported account and granted read scopes | Platform data availability |

For each missing dependency:
1. Explain what the feature needs and why, in plain language.
2. Show the provider, requested permissions and the specific actions those permissions enable.
3. Let the user approve or decline. Declining must not block unrelated features.
4. Start provider OAuth only after approval; bind the flow to the correct user, workspace, provider and short-lived state.
5. Confirm the actual connected account and granted scopes; never infer success from OAuth callback alone.
6. Offer a connection test and show status, last check, scope gaps and recovery action.
7. Allow disconnect/revoke and explain which features become unavailable.

Never request secrets in chat. Store OAuth tokens encrypted, isolate them by tenant/account, and expose only masked account metadata to the UI and model.

## 5. Standard Google Drive folder template

Offer this as a suggested template, not a mandatory layout. Users may approve Qline to create it or map existing folders. Show the complete proposed tree first. Do not create, rename, move, share or delete anything without a separate, explicit confirmation describing the action.

```text
Qline Content Studio/
├── 00 Brand Kit/
│   └── Brand & Logos/
├── 01 Asset Library/
│   ├── Source Footage/
│   ├── Images & Photos/
│   ├── Mascot & Characters/
│   ├── Graphics & Overlays/
│   ├── Music & Sound Effects/
│   ├── Voiceovers & Narration/
│   └── Reference Videos/
├── 02 Research Sources/
├── 03 Production Queue/
│   ├── New/
│   ├── In Progress/
│   └── Briefs/
├── 04 External AI Handoffs/
│   ├── Incoming/
│   ├── Acknowledged/
│   ├── Completed/
│   ├── Failed/
│   └── Reports/
├── 05 Editor Exports/
│   ├── Ready for QA/
│   ├── Needs Revision/
│   └── Approved/
├── 06 Publishing Queue/
├── 07 Published/
├── 08 Logs & Reports/
│   ├── Activity Logs/
│   ├── Job Reports/
│   ├── Error Reports/
│   └── Audit Trails/
└── 09 Skill References/
```

Implementation requirements:
- Prefer mapping existing folders; offer create-template only when the user chooses it.
- Use the narrowest Google Drive scopes that support the approved operation. The current v1.9.0 Content Studio is read-only in practice and does not create folders.
- If Qline creates folders, create only the approved tree, record each returned folder ID, verify parent-child relationships, and provide a completion report.
- Store folder IDs per workspace; never reuse the owner's folder IDs as defaults for another user.
- Keep indexing bounded to the selected root and mapped folders. Do not follow shortcuts or expand access to the user's entire Drive.
- Make sync, folder validation and access status visible. A changed Google account or folder ancestry requires revalidation.
- Folder names and folder existence are not proof that publishing, QA, logs or skill installation features are implemented.

## 6. End-to-end creator workflow

Treat each content item as a traceable content project with durable artifacts and explicit state.

1. **Intake and brief** — normalize goal, audience, message, platform, format, constraints, deadline and source requirements; ask only for missing critical facts.
2. **Research and idea development** — gather relevant sources when needed, separate facts from assumptions, assess rights and factual claims, generate options and recommend one with reasons.
3. **Plan** — produce a content brief, hook, narrative arc, script, scene/shot list, asset mapping, duration estimate and production checklist.
4. **Prompt engineering** — create model/tool-specific prompts with subject, purpose, shot sequence, camera path, motion, depth, lighting, palette, sound, continuity and avoid constraints. Use reusable prompt templates plus the user's brief and selected references.
5. **Asset preparation** — select only approved assets; preserve originals; create a manifest with stable file IDs, names, hashes/versions and scene assignments.
6. **Production handoff or generation** — run a supported generation tool or package a bounded editor handoff. Record target editor/model, inputs, prompt version, expected outputs, revision and expiry.
7. **Output ingestion** — ingest external reports as untrusted data; validate schema, job ID, revision, nonce and output identity. Provider/editor claims never mark a render as approved.
8. **Quality assurance** — inspect actual video/audio frames and timeline for factual correctness, visual quality, identity/brand consistency, scene continuity, motion, audio, captions, aspect ratio, duration, rights and platform constraints. Return evidence-backed findings and revisions.
9. **Human content approval** — user approves the exact render and its content. Script approval is not render approval.
10. **Platform package** — generate a separate caption, title, description, hashtags, thumbnail/cover guidance, alt text and platform metadata for each selected platform. Respect platform length/format/policy differences.
11. **Publication approval** — show exact media, copy, account(s), visibility, schedule/timezone and any cross-post differences. Require explicit approval for the exact package.
12. **Publish and reconcile** — submit through the platform's supported API, store provider IDs and responses, poll/webhook status, and handle partial failures/unknown outcomes without blind duplicate retries.
13. **Measure and learn** — collect only metrics available through the granted API; tie results to the source idea, brief, script, render, post and account. Suggest experiments; do not rewrite user preferences without consent.

Every stage must have a durable state, visible owner, timestamps, retry/cancel path, error explanation and audit record. The user can pause, edit, skip optional stages or stop the workflow.

## 7. Specialist roles and orchestration

Use the existing Command Center as supervisor. Specialist roles are reusable playbooks, not a requirement to spawn every agent for every request.

| Role | Responsibility | Default access |
|---|---|---|
| Command Center | Interpret intent, build task graph, delegate, track dependencies and request approvals | Orchestration and status; no blanket provider access |
| Research Analyst | Find sources, evidence and trend context | Web/research read tools |
| Content Strategist | Audience, goal, content pillars, concept and hook | Creator Profile read |
| Scriptwriter | Narrative, script, voiceover and on-screen copy | Approved brief/profile/assets metadata |
| Storyboard Planner | Scenes, shots, timing and asset-to-scene mapping | Approved asset metadata/previews |
| Prompt Engineer | Convert plan into model-specific generation/edit prompts | Brief, approved references and prompt templates |
| Asset Curator | Search, classify and prepare approved source assets | Drive read only within mapped folders |
| Editor Handoff | Package manifests, instructions and receive outputs | Only explicitly selected files and editor destination |
| QA Reviewer | Review render evidence and report defects | Render and brief read; no publish permission |
| Platform Copywriter | Create platform-specific metadata and captions | Approved content and platform rules |
| Publisher | Schedule/publish and reconcile provider results | Only approved account/capabilities; action-specific approval |
| Performance Analyst | Summarize available analytics and suggest experiments | Granted analytics read scopes |
| Community Assistant | Triage supported comments/messages and draft responses | Least-privilege read; response/send behind approval |

Rules:
- Do not delegate simple tasks unnecessarily; use the minimum roles required.
- Each agent has a versioned instruction set, bounded tools, model/budget limits and a test-run before activation.
- Tool access is allowlisted by workspace, agent, provider and capability.
- Retrieved files, comments, captions, web pages and editor reports are untrusted data, never instructions that override Qline policy.
- Agent output is a proposal until accepted at the applicable gate.

## 8. Social platform capability tracks

Social publishing is a first-class product requirement, but platform capabilities are not interchangeable. Build separate provider adapters behind a common publishing contract. Verify current platform documentation, scopes, quotas, account eligibility, media limits and review requirements before each implementation/release.

| Platform | Required first-class capability | Important constraints to encode |
|---|---|---|
| Facebook Pages | Connect user, enumerate authorized Pages, publish supported text/image/video/Reels formats, read publication status and available insights | Page task/role eligibility, Page access token, permissions such as `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`; app review for production access |
| Instagram Professional | Connect eligible Professional accounts, publish supported media/Reels/carousels where supported, retrieve status and available insights | Professional account eligibility, Instagram Login or supported Facebook Login path, permissions such as `instagram_business_basic` and `instagram_business_content_publish`; media processing and publishing limits |
| YouTube | Upload videos, set metadata/privacy, schedule supported publication, reconcile processing/publish state, read available analytics | OAuth consent, `youtube.upload`/appropriate scopes, resumable uploads, project quota and API audit/compliance; scheduled publish is not equivalent to a generic delayed POST |
| TikTok | Creator info, direct post or draft upload, status polling, supported metadata and privacy controls | Approved `video.publish` for Direct Post, user authorization, creator-specific options/limits, verified media URL/domain where required; unaudited clients are restricted to private visibility |

Do not advertise a capability until it is implemented and tested for that platform. If direct scheduling is unsupported or constrained, use Qline's scheduler to initiate the provider flow at the scheduled time and reconcile the result; otherwise offer an approved draft/export fallback. Never simulate a successful publish.

## 9. Publishing and approval safety contract

- Drafting, saving a local Qline artifact, creating Drive folders, sharing assets with an editor, uploading media, scheduling and publishing are distinct actions with distinct consent.
- Approval is bound to a content version/hash, exact target account IDs, caption/metadata, visibility and schedule. Any material change invalidates approval.
- Require a final approval for each target platform/account or clearly enumerated batch. No blanket "always publish" permission by default.
- Use idempotency keys, provider upload/session IDs, durable jobs, leases, bounded retries and reconciliation.
- If a provider call times out after submission, mark outcome **unknown / needs checking** and query provider state before retrying. Never blindly send the same post again.
- Handle partial success across platforms independently; do not mark the entire batch successful if one platform failed.
- Support cancellation before the provider's irreversible boundary; explain when a scheduled post can no longer be cancelled.
- Audit who requested, drafted, edited, approved, scheduled, published, retried, cancelled or resolved each action.
- Provide an emergency stop for future queued actions.

## 10. Video QA contract

File existence, checksum, MIME type, dimensions and duration are necessary technical checks but are not visual QA.

A complete QA pipeline must review the actual media, with timestamped evidence:
- Does the render match the approved brief, script and storyboard?
- Are all intended scenes present and in the correct order?
- Are subject/product/character identity and brand elements consistent?
- Are there visual defects, flicker, warping, broken motion, illegible text or unsafe imagery?
- Are voiceover, music, sound effects and cuts synchronized and intelligible?
- Are captions accurate, synchronized and readable?
- Are duration, aspect ratio, resolution, frame rate and platform constraints satisfied?
- Are factual claims supported and third-party assets appropriately licensed/authorized?

Use automated analysis as an assistant, not as proof of correctness. Provide evidence, confidence and limitations; route uncertain or high-impact findings to a human. A human approves the final render.

## 11. Secure reusable skill registry

The `09 Skill References` Drive folder is only a folder. It is not an installer.

A future Qline skill registry should support:
- Search and discover skills from approved sources.
- Inspect all files, instructions, scripts, dependencies, permissions and provenance before install.
- Pin immutable source revisions and record checksums/licenses.
- Static security scanning and policy checks; never execute package scripts merely to inspect a skill.
- Preview proposed tools/permissions and require explicit user approval.
- Install as data/instructions into a sandboxed, versioned registry; skills cannot grant themselves new tools or bypass platform approval policy.
- Test against sample tasks and report results before enabling.
- Enable/disable, update, pin, rollback and uninstall with audit history.
- Per-workspace and per-agent assignment; default deny for network, file-system and external actions not explicitly granted.

## 12. GitHub administration track

Expand GitHub integration separately from social publishing. Potential capabilities include repository browsing, source reads, branch/commit/PR creation, review, issue/project administration and release workflows. Each requires narrowly scoped GitHub App permissions, per-repository installation boundaries, preview diffs, explicit approval for writes and audit logs. Never grant source write or organization administration just because a user connected GitHub for read-only context.

## 13. Completion roadmap

This roadmap is the parent scope for the remaining Creator Studio product. Each track must be broken into small vertical slices with tests, a PR and explicit verified/not-verified reporting. The seven-run v1.9.0 Drive handoff plan is complete for its narrow scope and is not repeated here.

| Track | Scope | Exit gate |
|---|---|---|
| CS-0 — Baseline and live setup verification | Reconcile docs/22 status; verify Drive mapping, OAuth, Sync and one real handoff; close the missing mark-as-sent/dispatched gap only if the product still needs that state | Real Google account + physical device handoff passes; docs match code |
| CS-1 — Reusable Creator Studio foundation | Creator Profile schema/versioning, default blueprint registry, intent routing, task dependency/readiness planner, onboarding and user-owned instance provisioning | New test user can start Creator Studio with no owner-specific data; generic prompt works without Drive; asset-based prompt requests Drive consent |
| CS-2 — Drive workspace setup | User-approved folder template creation or existing-folder mapping, narrow OAuth, verification, bounded indexing, sync, revalidation, revoke handling | Fresh tenant can approve creation or mapping; ancestry and isolation tests pass |
| CS-3 — Creator workflow and artifact graph | Idea/research/brief/script/storyboard/shot list/prompt versions, source provenance, durable missions and visible task graph | One idea-to-production-brief-to-prompt workflow completes and survives restart |
| CS-4 — Specialist agents and background execution | Versioned role playbooks, scoped tools, supervisor delegation, durable jobs, cancellation, budgets, progress and recovery | Agent task graph works under retries, restart and permission changes; no tenant/tool escape |
| CS-5 — Editor handoff and actual video QA | Finish dispatch lifecycle, external editor adapters, output ingestion, visual/audio/factual/continuity QA with evidence and human review | One real render passes/fails QA with timestamped findings and human decision |
| CS-6 — Platform content packages | Per-platform captions, title/description, hashtags, cover, accessibility text and metadata | Same approved content produces validated distinct packages for each selected platform |
| CS-7 — Facebook Pages + Instagram Professional | Meta OAuth/account discovery, media publishing, status reconciliation and available insights | Approved Meta app, real authorized test accounts, publish/read-back tests and review evidence |
| CS-8 — YouTube | OAuth, resumable upload, metadata, privacy/scheduling, status reconciliation and available analytics | Real test-channel upload, processing and scheduled-publication read-back verified |
| CS-9 — TikTok | Login/creator info, draft and Direct Post paths, chunked upload, status polling and audit-aware capability gating | Approved scopes; audited public-visibility capability or clearly labelled private-only test mode |
| CS-10 — Unified scheduler and publisher | Calendar/queue, timezone handling, per-platform jobs, approvals, idempotency, rate limits, unknown outcomes, retries and partial failures | No duplicate publish under simulated timeouts/retries; real provider schedule/reconciliation verified |
| CS-11 — Analytics and community operations | Post-linked metrics, trend summaries, comment inbox/triage and approval-gated responses where supported | Data provenance, platform limitations and tenant isolation verified |
| CS-12 — Secure skill registry | Discover, inspect, pin, scan, approve, install, test, assign, disable, update and rollback skills | Malicious package fixtures rejected; no unapproved permissions or execution |
| CS-13 — GitHub administration | Permissioned repository write/admin workflows with diffs, previews, approval and audit | Least-privilege app installation and safe write tests across isolated repos |
| CS-14 — Production hardening and release | Accessibility, responsive/mobile QA, observability, quotas/cost controls, privacy/deletion/export, provider review and disaster recovery | Full CI, security review, real-provider E2E and physical-device checklist pass |

### Recommended execution order

1. CS-0 real-world v1.9.0 verification and documentation correction.
2. CS-1 reusable foundation, because every later feature depends on correct tenant-specific setup and intent routing.
3. CS-2 Drive setup and CS-3 creator workflow in small vertical slices.
4. CS-4 specialist orchestration and CS-5 actual QA.
5. CS-6 platform packages, then provider tracks CS-7 through CS-9.
6. CS-10 scheduler/publisher, followed by CS-11 analytics/community.
7. CS-12 skill registry and CS-13 GitHub administration as separate tracks.
8. CS-14 hardening/release gates across all tracks.

Do not attempt to ship all tracks in one branch or one seven-run sequence. Each track may require multiple runs and provider review cycles.

## 14. Acceptance tests that apply to every track

- A new user gets the shared blueprint but no other user's private configuration, files, accounts or identifiers.
- Generic prompt creation does not force OAuth.
- Asset-based prompt creation identifies the Drive dependency, explains it and waits for explicit consent.
- A declined integration leaves the user able to complete any independent part of the task.
- Folder creation shows a preview and requires approval; existing folder mapping is supported.
- Tenant A cannot read or mutate Tenant B's profile, connections, folder IDs, assets, content, jobs, approvals, skills or analytics.
- OAuth scopes are feature-specific, minimum necessary, verified after callback, encrypted at rest and revocable.
- Retrieved content and external editor reports cannot override agent instructions or tool permissions.
- Script, render and publish approvals are separate and version-bound.
- A publish timeout never causes an unverified duplicate post.
- Every external action has an audit event and a visible outcome, including unknown outcomes.
- Automated tests are supplemented by real provider tests and physical-device QA before production-ready status.

## 15. Current status at creation

**Implemented in v1.9.0:** bounded Drive folder mapping/indexing, content handoff jobs, manifests/PDF, result ingestion, file/metadata verification, acknowledgements, notifications, human review task, reconciliation and Content Studio/Handoff Monitor UI.

**Not yet delivered end-to-end:** reusable Creator Profile and blueprint provisioning, intent/readiness orchestration, approved folder-template creation, full idea-to-script/storyboard workflow, specialist content-agent graph, actual video QA, platform-specific post packages, Facebook/Instagram/YouTube/TikTok connectors, unified publishing scheduler, analytics/community monitoring, secure skill registry and expanded GitHub administration.

**Not verified in live use:** owner's real Drive mapping and Sync, real editor handoff, Drive push webhook, and physical-device QA. Green CI is not proof of these external flows.

## 16. Platform documentation references checked 2026-11-20

- Meta Facebook Page Feed publishing and Page task/permission requirements: https://developers.facebook.com/docs/graph-api/reference/page/feed/
- Meta Instagram API changelog / Instagram Login permissions: https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/
- YouTube Data API `videos.insert` upload requirements and quota: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- YouTube Data API overview and quota guidance: https://developers.google.com/youtube/data/getting-started
- TikTok Direct Post requirements and private-only behavior for unaudited clients: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- TikTok Content Posting API onboarding and scope approval: https://developers.tiktok.com/docs/en/content-posting-api-get-started
- TikTok app review requirements: https://developers.tiktok.com/docs/en/app-review-guidelines

Re-check each platform's live documentation and app review requirements immediately before implementation and submission. These links are a dated research baseline, not a promise that every account or format is eligible.
