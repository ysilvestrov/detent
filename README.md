# detent

> A detent holds a mechanism in position and won't let it slip back.

A self-contained set of skills and small tools for software development with AI coding agents:
Claude Code, Codex and Google Antigravity. It also composes with [Superpowers](https://github.com/obra/superpowers).

Two roles run through the process:

- **The owner** is the human the project belongs to. The owner sets the goal, answers the
  questions a spec raises, approves the spec and merges the pull requests.
- **The author** is the AI agent that writes a spec, a plan or the code: Claude Code, Codex or
  Antigravity, and the model it runs on.

The process grew out of a real project and rests on four ideas:

- **Evidence before decisions.** A task is classified only after a live probe. Anything the system
  records as fact carries its proof.
- **The owner approves; the owner doesn't have to read everything.** Every spec opens with a
  section for the owner, which holds everything that matters for the decision. The rest of the
  spec is for the agent that writes the plan.
- **A one-way ratchet.** When a light path stops being light, the work stops and restarts on the full
  cycle. Every incident becomes a rule.
- **The author doesn't review its own work.** Before the owner sees a spec, and before a pull
  request opens, the author's work is reviewed by an agent running a model from a different family
  (Anthropic, OpenAI or Google). A different CLI on the same model family doesn't count.

## Status

Work in progress. Release 1 is planned to include:

- a project constitution template;
- design specs with an owner section and an estimation game;
- PR slicing;
- cross-review across models.

Release 2 is planned to add AI PR review in GitHub as a reusable Action.

Design documents live in `docs/specs/` and `docs/plans/`.
