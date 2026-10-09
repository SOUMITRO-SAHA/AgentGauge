---
description: Update the single project-wide CHANGELOG.md from the current task
---

Update the project-wide changelog for the work completed in this session.

1. Inspect the current task, relevant changes, and the root `CHANGELOG.md` if it exists. Use the actual work in the current session and repository as the source of truth; do not invent completed features or include unrelated historical changes. Use `$ARGUMENTS` as additional context when provided.
2. Edit **only the root `CHANGELOG.md`**. Do not create or update changelog files elsewhere, and do not modify source, documentation, or any other files.
3. Preserve the existing format. If no changelog exists, create a concise Markdown changelog at the repository root with an `Unreleased` section. Add this task's user-relevant changes under suitable categories, avoid duplicate entries, and keep older entries intact.
4. If this task has no meaningful user-facing change to record, leave the file unchanged and say why.

Report the changelog entry added, or that no update was needed.
