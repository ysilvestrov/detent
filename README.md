# detent

> A detent holds a mechanism in position and won't let it slip back.

A self-contained set of skills and small tools for software development with AI coding agents:
Claude Code, Codex and Google Antigravity. It also composes with [Superpowers](https://github.com/obra/superpowers).

The process grew out of a real project and rests on four ideas:

- **Evidence before decisions.** A task is classified only after a live probe. Anything the system
  records as fact carries its proof.
- **The author doesn't review.** Specs and code are reviewed by a different model from the one that
  wrote them.
- **A one-way ratchet.** When a light path stops being light, the work stops and restarts on the full
  cycle. Every incident becomes a rule.
- **The owner approves; the owner doesn't have to read everything.** Everything that matters is in
  the first section.

## Status

Work in progress. Release 1 is planned to include:

- a project constitution template;
- design specs with an owner section and an estimation game;
- PR slicing;
- cross-review across models.

Release 2 is planned to add AI PR review in GitHub as a reusable Action.

Design documents live in `docs/specs/` and `docs/plans/`.
