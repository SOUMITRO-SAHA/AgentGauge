---
description: Update project documentation only within the root docs/ directory
---

Update documentation for the current task, using the repository's implemented behavior as the source of truth.

1. Inspect the relevant existing documents under the root `docs/` directory and the project files needed to verify the facts. Use `$ARGUMENTS` as additional context when provided. Do not describe planned behavior as implemented.
2. Edit or add documentation **only inside the root `docs/` directory**. Do not update the README, source files, changelog, or any other paths. If `docs/` does not exist, create it and put the relevant document there.
3. Prefer updating the most relevant existing document; add a new focused document only when needed. Keep the documentation accurate, concise, consistent with the existing style, and free of secrets or personal data.
4. If the task does not warrant a documentation change, leave files unchanged and say why.

Report the documentation file(s) updated, or that no update was needed.
