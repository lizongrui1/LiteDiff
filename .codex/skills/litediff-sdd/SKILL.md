---
name: litediff-sdd
description: Apply LiteDiff's repository-local Spec-Driven Development workflow to feature, bugfix, security, performance, architecture, release, and documentation changes. Use when modifying or reviewing this project; do not use for general coding questions unrelated to LiteDiff.
---

# LiteDiff SDD

Use the repository's own specs and verification commands as the source of truth. Work from the Git repository root:

```bash
git rev-parse --show-toplevel
```

## Read before changing files

Read these in order, then open only the referenced material relevant to the task:

1. `docs/progress/MASTER.md`
2. `AGENTS.md`
3. `docs/sdd/constitution.md`
4. `docs/sdd/workflow.md`
5. `specs/product/litediff.md`
6. `specs/README.md`
7. The active `specs/changes/<id>/` and relevant `SEC-NN` / `PERF-NN` entries in `docs/sdd/security-and-performance.md`

Check `git status --short` before editing. Preserve unrelated user changes.

## Select the required process

- `L0`: documentation, comments, or no-behavior formatting. No change directory; report why behavior is unchanged.
- `L1`: single-module fix. Create `spec.md` and `verification.md`.
- `L2`: feature, cross-file refactor, IPC, data model, or performance change. Create all four change artifacts and update the product spec.
- `L3`: security, file writes, Git execution, history format, release, or major algorithm/architecture change. Add an ADR, threat/performance analysis, rollback plan, and cross-platform validation plan.

If the user asks for an implementation without an adequate L1-L3 record, create or complete the record before changing runtime code. Do not silently treat the current implementation as the desired specification.

## Implement within project boundaries

- Keep Rust and TypeScript IPC shapes synchronized.
- Treat renderer input as untrusted; never grant save capability from a path alone.
- Do not introduce network access, telemetry, broader Tauri permissions, or uncontrolled Git execution.
- Preserve the bounded behavior documented for Myers, token diff, search, documents, Git output, and history.
- Update all seven locales for user-visible text.
- Keep behavior changes separate from unrelated refactors.
- Never use destructive Git commands or reformat unrelated files.

For a bug, reproduce it and add a regression test before the minimal fix. For a behavior change, update tests and `specs/product/litediff.md` in the same change.

## Verify and report

Run the full repository gate from the root:

```bash
bash scripts/verify.sh
```

On Windows, use `powershell -ExecutionPolicy Bypass -File scripts\verify.ps1`. If a required platform or tool is unavailable, mark the check `NOT RUN` with a reason; never report it as passing.

Record actual commands and results in the active `verification.md`, update `docs/progress/MASTER.md` for multi-phase work, and end with the change level, affected behavior, evidence, and residual risks. Do not commit, push, open a PR, or release unless the user explicitly requests it.
