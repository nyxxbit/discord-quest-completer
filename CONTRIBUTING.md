# Contributing to Orion

Thanks for taking the time to contribute! This project is community-maintained and educational — patches, bug reports, and suggestions are all welcome.

## Before you open a PR

1. **Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** It explains how the script is structured, where each responsibility lives, and which invariants we rely on.
2. **Open an issue first for non-trivial changes.** A 2-minute conversation upfront saves a lot of back-and-forth in review. Small fixes (typos, one-line bugs) can go straight to a PR.
3. **Check existing issues.** Your idea might already be tracked or declined.

## Local workflow

Orion has **no build step**. You edit `index.js` directly. Recommended flow:

```bash
# clone
git clone https://github.com/nyxxbit/discord-quest-completer.git
cd discord-quest-completer

# lint before pushing
npx eslint@9 index.js

# syntax check
node --check index.js
```

Both checks run in CI on every PR — make them pass locally first.

## Testing changes

There is no automated test harness. Changes must be validated manually:

1. Open Discord desktop (Stable, PTB, or Canary).
2. Open DevTools (`Ctrl+Shift+I`).
3. Paste your edited `index.js` into the console.
4. Verify the behavior you changed. Check the log panel for errors.
5. Click **STOP** and confirm clean shutdown (no orphan listeners, no console errors).

## Code style

- **Single-file IIFE.** Every addition stays inside the outer `(async () => {...})()` wrapper.
- **No new dependencies.** The script must remain paste-ready in the console.
- **`const` over `let`** unless reassignment is required.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `perf:`.
- **Short imperative commit titles** (< 72 chars). The body explains *why*, not *what*.
- **English only** in code, comments, and commit messages. Issue discussion can match the reporter's language.
- **Strings in dashboard UI** should be concise and neutral in tone.

## What we accept

- Bug fixes with a clear reproduction.
- UI/UX improvements to the dashboard and quest picker.
- Documentation (README, ARCHITECTURE, inline comments).
- CI and tooling improvements.
- Support for new Discord builds when store discovery breaks.

## What we don't accept

- Features that pipe user data to third-party services.
- Anything that requires a build step or npm package to be installed by end users.
- Changes that remove the educational/readable nature of the code.
- Aggressive anti-detection measures that trade clarity for marginal stealth.

## Pull request checklist

- [ ] ESLint passes (`npx eslint@9 index.js`).
- [ ] `node --check index.js` passes.
- [ ] Manually tested in the Discord desktop client.
- [ ] README / ARCHITECTURE updated if behavior or structure changed.
- [ ] `CONFIG.VERSION` bumped if the change is user-facing.
- [ ] Changelog entry added at the top of the README changelog section.
- [ ] Commit messages follow conventional commit style.
- [ ] No `console.log` left behind for debugging.

## Release process (maintainers only)

1. Merge PR(s) into `main`.
2. Confirm `CONFIG.VERSION` in `index.js` matches the new tag.
3. Update README (badge, header, changelog) in the same or follow-up commit.
4. `gh release create vX.Y.Z ./index.js --title "vX.Y.Z — <short summary>" --notes "..."` — always attach `index.js` as an asset.

## Reporting issues

Use the provided issue templates. When reporting a bug, include:

- Discord client channel (Stable / PTB / Canary).
- Full error text from the console (not a screenshot of a screenshot).
- The quest name and type where the bug occurred, when relevant.
- The Orion version (visible at the top of the dashboard).

## Code of conduct

Be kind. Assume good faith. Reviews are about the code, not the author.
