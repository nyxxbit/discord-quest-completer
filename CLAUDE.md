# CLAUDE.md — Orion Project Instructions

## Identity

- **Never** add `Co-Authored-By` lines to commits. No Claude attribution anywhere.
- **Never** list Claude as a contributor in README, package.json, or any file.
- Commits must appear solely authored by the user.

## Language

- Match the language of the person you're responding to (issues, PRs, comments).
- If the issue is in Portuguese, respond in Portuguese. English issue, English response.
- Code comments and variable names stay in English always.

## Pull Request Review

When reviewing PRs:

1. Read the full diff — every file, every hunk.
2. Verify changes don't introduce security vulnerabilities (injection, XSS, token leaks).
3. Check code quality: dead code, unused variables, logic errors, race conditions.
4. Verify version bumps match the scope of changes.
5. Check that CONFIG/SYS changes are backward-compatible or documented.
6. For `index.js`: validate API endpoint paths, payload shapes, and timing values against Discord's known behavior.
7. Approve and merge only when confident. Request changes otherwise.

## Issue Triage

When reviewing issues:

1. Classify: bug, feature request, support question, duplicate, or invalid.
2. Bugs: check if reproducible from the description, link to relevant code lines.
3. Feature requests: assess feasibility and scope, label as `enhancement`.
4. Support questions: answer directly, close with `wontfix` if not actionable.
5. Duplicates: link the original issue, close as duplicate.

## Releases & Versioning

After merging PRs that change `index.js`:

1. Read the merged code — extract the new `CONFIG.VERSION` value.
2. Update `README.md`:
   - Version badge and header text.
   - Changelog section with concise bullet points describing what changed.
   - CONFIG example block if config options were added/removed/changed.
   - Architecture diagram if structural changes occurred.
   - "How it works" table if quest handling logic changed.
3. Keep README professional, concise, and accurate. No filler.

## README Standards

- All version references must be consistent (header, badge, config block, changelog).
- Changelog entries use `###` heading with version number.
- Each entry has bold feature name + em-dash + short description.
- Newest version at the top of the changelog.
- Never add sections that don't exist — only update existing ones.

## Code Style

- Single-file IIFE architecture. No build tools, no external deps.
- `const` over `let` unless reassignment is needed.
- Descriptive error messages in `Logger.log()` calls.
- All API delays use `rnd()` ranges, never fixed values.
- PIDs must be multiples of 4 (Windows NT kernel).

## Commit Messages

- Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`.
- Short imperative title (< 72 chars).
- Body explains **why**, not what.
- No `Co-Authored-By` lines. Ever.

## Vencord Plugin (`vencord-plugin/`)

- Separate from main `index.js` — different architecture (Vencord plugin API).
- Uses Vencord's `findByProps`/`findStore` instead of manual webpack discovery.
- TypeScript with Vencord conventions.
- ESLint config intentionally excludes this directory (see `.eslintrc`).
