---
name: design-doc-review
description: Reviews design documents at a specified path for logical inconsistencies, fallacies, contradictions, anti-patterns, security flaws, and implementation risks. Use when the user asks to review a design document, design doc, technical design, architecture plan, ADR, RFC, or plan file, especially when a path is provided and they may want proposed changes applied after approval.
metadata:
  argument-hint: <design-document-path>
---

# Design Document Review

Use this skill to critique a design document before implementation or to improve an existing design document after user approval.

## Workflow

1. Require a specific document path. If the user did not provide one, ask for it before reviewing.
2. Read the whole design document. If it references related docs, APIs, schema, or code paths needed to verify claims, inspect only the relevant supporting files.
3. Review the document for:
   - Logical inconsistencies, contradictions, circular reasoning, unsupported assumptions, and fallacies.
   - Missing requirements, unclear ownership, vague success criteria, hidden dependencies, and unresolved edge cases.
   - Architecture and implementation anti-patterns, unnecessary complexity, weak boundaries, and mismatches with existing project conventions.
   - Security flaws, including auth bypasses, tenant isolation gaps, replay risks, unsafe webhooks, secret exposure, PII handling, injection risks, SSRF, rate limits, and over-broad permissions.
   - Data model, migration, rollback, observability, testing, and operational risks.
4. Return findings first, ordered by severity. Each finding should include the affected section or heading, the issue, why it matters, and the proposed correction.
5. Propose a concise change set for the document. Do not edit the document yet.
6. Ask the user whether they want the proposed changes resolved in the document.
7. If the user approves, update the design document directly. Keep edits scoped to the approved changes, preserve the document's voice and structure, and avoid changing source code unless the user explicitly asks.
8. After editing, summarize what changed and call out any remaining assumptions, unresolved questions, or risks.

## Review Standards

- Verify claims against the codebase or referenced documentation when practical; do not treat confident prose as evidence.
- Prefer precise corrections over broad rewrites.
- Mark assumptions explicitly instead of inventing missing requirements.
- Preserve useful nuance. Do not flatten trade-offs into absolute claims.
- If schema, data, or production behavior changes are implied, ensure the document includes a migration or rollout strategy.
- If the design touches authentication, authorization, multi-tenancy, payments, webhooks, external integrations, or user data, treat security and abuse cases as first-class review areas.

## Response Format

For the initial review, use this structure:

```markdown
## Findings
- **Severity: [Critical|High|Medium|Low]** — [Section or heading]
  [Issue, impact, and proposed correction.]

## Proposed Change Set
- [Concrete document change]

## Approval
Do you want me to apply these changes to `[path]`?
```

If there are no findings, say that clearly and mention any residual review limits, such as unverified external assumptions or missing runtime evidence.
