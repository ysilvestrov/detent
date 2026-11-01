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

## Release 1 (v0.2.0)

- **A constitution block** for `CLAUDE.md` and `AGENTS.md`: the spec as the single source of
  truth, classification after the probe, the one-way ratchet, claim → evidence, test quality, the
  reviewer is not the author, Superpowers overrides (checked against Superpowers 7.0.1), the
  deletion rule.
- **Four skills**: `detent-design-spec` (a spec with an owner section, the estimation game, the
  claim → evidence table; the format is in `spec-format.md` next to it), `detent-pr-slicing`,
  `detent-cross-review`, `detent-dev-cycle` (only when invoked explicitly, for projects without
  Superpowers).
- **The `detent` CLI** with two commands, `install` and `cross-review`. Node ≥ 20, no runtime
  dependencies.
- **A Claude Code plugin** over the same `skills/` directory, as a second way to get the skills
  into Claude Code.

Release 2 is planned to add AI PR review in GitHub as a reusable Action. Design documents live in
`docs/specs/` and `docs/plans/`.

## Install

Release 1 is installed from git only; there is no npm package.

```
npm i -D github:ysilvestrov/detent#v0.2.0
npx detent install [--claude] [--agents] [--dry-run] [--superpowers yes|no]
```

npm builds `dist/` with the package's `prepare` script when it installs the git dependency.
One-off, without adding the dependency: `npx github:ysilvestrov/detent#v0.2.0 install`.

Run it inside a git repository: the project root is `git rev-parse --show-toplevel`. Without a
target flag both targets are installed.

| Target | Skills | Constitution block |
|---|---|---|
| `--claude` | `.claude/skills/detent-<name>/` | `CLAUDE.md` |
| `--agents` (Codex, Antigravity) | `.agents/skills/detent-<name>/` | `AGENTS.md` |

What install writes, and its rules:

- **Copies, not links.** Files are written with LF line endings.
- **Manifest** `.detent/manifest.json`: the detent version and, for each skill file, its path,
  version and sha256; for `CLAUDE.md`/`AGENTS.md`, the sha256 of the block between the markers
  only. Hashes ignore CRLF vs LF, so `core.autocrlf` does not count as an edit. The manifest is
  written last.
- **A changed file is never overwritten.** A skill file or block whose hash does not match the
  manifest, or a file that exists without a manifest entry and differs from what install would
  write, is a conflict: install lists the conflicts, writes nothing at all (not even `detent.json`
  or `.gitignore`) and exits 4. There is no force flag: restore the file by hand or move your
  change outside the markers. A file without a manifest entry but with identical content is
  adopted into the manifest.
- **Nothing is ever deleted.** A skill the new version no longer ships stays on disk; install
  prints `<path>: stale, delete with a script if not needed`.
- **The constitution block** sits between
  ``<!-- detent:constitution v1 begin — edit outside these markers; `npx detent install` rewrites this block -->``
  and `<!-- detent:constitution end -->`. Only the text between them is replaced; your text
  outside them is kept byte for byte. No markers: the block is appended at the end of the file.
  A broken pair (one marker, or several): exit 4, nothing written.
- **The author line** of `detent-cross-review` differs by target. `.claude/` gets
  `You are Claude: pass --author claude.`; `.agents/` gets an instruction to pass `codex` in
  Codex, `agy` in Antigravity on a Gemini model, and `claude` when Antigravity runs on a Claude
  model.
- **Superpowers is detected per target.** `--claude`: a `superpowers@…` key set to `true` in
  `enabledPlugins` of the project's `.claude/settings.json` or of `~/.claude/settings.json`.
  `--agents`: a `superpowers` directory in `~/.codex/plugins/cache/*/`, or a `using-superpowers`
  skill in the project's `.agents/skills/`. The line
  ``Without Superpowers, start any behaviour change with `detent-dev-cycle` `` goes into the block
  only for a target where Superpowers was not found. Install prints, for each target, what it
  found and where, and whether it added the line. `--superpowers yes|no` overrides detection for
  both targets.
- **`detent.json`** is created with the defaults if it does not exist; an existing one is never
  touched.
- **`.gitignore`** gets a `tmpDir` line (from `detent.json`, else `tmp`) if no line names it.
- **`--dry-run`** prints the exact list of what would be created or updated and writes nothing.

Exit codes: 0 — done (`--dry-run` included); 2 — a usage error, not a git repository, an
unreadable manifest or `detent.json`, or `CLAUDE.md` and `AGENTS.md` (or the two skill
directories) being one file on disk through a link, in which case install one target only;
4 — a conflict, nothing written.

### Claude Code plugin (second path)

```
/plugin marketplace add ysilvestrov/detent
/plugin install detent@detent
```

The plugin gives Claude Code the skills only. It does not install the constitution block: run
`npx detent install --claude` for that. The plugin and the copied skills together give each skill
twice (the plugin's namespaced `detent:…` one and `detent-<name>` from `.claude/skills/`); install
warns when it sees the detent plugin enabled in the project's `.claude/settings.json`. Nothing
reaches Codex or Antigravity through the plugin.

## `detent.json`

In the project root. Every key is optional and a missing key takes its default. A `models` object
in the file replaces the default `models` as a whole. Unknown keys are ignored; a BOM is accepted.

| Key | Default | Meaning |
|---|---|---|
| `language` | `"uk"` | Language of the artifacts: specs, plans, decision tables, the owner section. The skills are in English and tell the agent to write artifacts in this language. |
| `specFile` | `"spec.md"` | The project's root spec. |
| `specsDir` | `"docs/specs"` | Design specs live in `<specsDir>/<YYYY-MM>/`; `cross-review --spec` accepts only a `.md` file there. |
| `plansDir` | `"docs/plans"` | Plans, in month folders too. |
| `gate` | `"npm test && npm run typecheck"` | The project's gate command. The skills and the constitution refer to it; the CLI does not run it. |
| `baseBranch` | `"origin/main"` | What `cross-review` diffs against without `--base`. |
| `tmpDir` | `"tmp"` | Where `cross-review` creates its run directories, relative to the root. Must be in `.gitignore`. |
| `reviewers` | `["codex", "claude", "agy"]` | The reviewer chain, in order, when `--reviewer` is not given. |
| `models` | `{ "codex": "gpt-6.1-sol", "agy": "gemini-4-argon" }` | The model pinned per reviewer. Without an entry the reviewer CLI's default applies. `agy` needs a `gemini-*` model here (or `--model`), otherwise it is left out of the chain. |
| `reviewContext` | none (the prompt says `none stated`) | Free text inserted as is into both review prompts after `Project context:` — the project's constraints. |

Reviewer ids are `claude`, `codex` and `agy`; any other id in `reviewers` or `models` is a config
error. An example for a real project:
[`examples/warsaw-beer-bot.detent.json`](examples/warsaw-beer-bot.detent.json).

## `detent cross-review`

```
npx detent cross-review --author claude|codex|agy [--reviewer <id>] [--base <ref> | --spec <file>] [--model <id>]
```

- `--author` is required (or `DETENT_AUTHOR`): the author cannot be detected from the
  environment. It is the caller's claim; the CLI checks only that the reviewer's model family
  (Anthropic, OpenAI, Google) differs from the author's.
- Without `--spec` it reviews the diff `<base>...HEAD`, where the base is `--base` or
  `baseBranch`. With `--spec` it reviews one committed spec under `<specsDir>/<YYYY-MM>/`.
  `--spec` with `--base` is a usage error, and so is `--model` without `--reviewer`.
- It refuses a dirty working tree, an empty diff and a spec not committed at `HEAD`: the review is
  pinned to a SHA, and the reviewer works in a snapshot worktree of exactly that SHA.
- The prompts come from the package's `prompts/`. A project may override them with
  `.detent/prompts/review-diff.md` and `.detent/prompts/review-spec.md`; an unknown placeholder is
  a usage error.
- The timeout is 15 minutes per reviewer process. From an agent, run it in the background: agents
  cut foreground commands off earlier. The reviewer's stdin is closed and it runs with
  `CROSS_REVIEW_ACTIVE=1`; a nested run refuses with exit 3.

Reviewers and what keeps each read-only:

| id | Family | Command | Read-only by |
|---|---|---|---|
| `codex` | OpenAI | `codex exec -s read-only --ephemeral -o <report> [-m <model>] <prompt>` | the Codex sandbox |
| `claude` | Anthropic | `claude -p --restricted --strict-mcp-config --tools Read,Grep,Glob --add-dir <runDir> [--model <m>] -- <prompt>` | a tool set without write tools |
| `agy` | Google | `agy --settings '{"permissions":{"deny":["write_file(*)"]}}' --sandbox --model <m> --output-format text -p <prompt>` | a session deny rule, proved by a canary on every run |

### The chain

Without `--reviewer`, the chain is every reviewer in `reviewers`, in order, whose family differs
from the author's and whose model is accepted (`agy` needs an explicit `gemini-*` model). With the
default config a Claude author gets `codex → agy`, a Codex author `claude → agy`. If no reviewer
is eligible, that is exit 2 with the reason for each one.

The CLI tries them in turn until one succeeds. A reviewer that is not installed (not in `PATH`),
exits non-zero (a usage limit, authentication, an unknown model), fails to start, fails its canary
or returns a report that does not end with the line `CROSS-REVIEW-RESULT: <n> findings` has
failed, and the next one runs. **A timeout stops the chain**: the reviewer worked and did not
finish, and another 15 minutes is not worth it. A reviewer of the author's own family never stands
in. With `--reviewer` the chain is that one reviewer, with no fallback.

### `agy`: the deny rule and the canary

`agy -p` writes files with your user's rights wherever it is asked to, outside the repository
too; neither `--sandbox` nor `--mode plan` stops it. Only the session rule `write_file(*)` does,
and it blocks `edit_file` as well. A rule with a wrong syntax is ignored silently, so before each
review the CLI runs a canary: `agy`, with the same settings and model, is asked to write
`<runDir>/canary`. The canary passes only when no file appears, `agy` exits 0 and its output
contains `deny rule` (agy 1.4.12 prints `… Matches user-configured deny rule.`). Otherwise `agy`
does not review, and the reason is in the marker, in `failed (…)` or in the fallback tail:

```
Cross-review: failed (author: claude; codex: not installed; agy: canary failed, review not run: no "deny rule" in its output)
Cross-review: codex/gpt-6.1-sol @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected (fallback: agy — canary failed, review not run: no "deny rule" in its output)
```

(The second line is from a config whose `reviewers` puts `agy` before `codex`.)

Other canary details: `deny rule ineffective (canary file was written)`, `timeout after 15 min`
(stops the chain), `did not run to completion: …`, agy's own error line, `exited with code <n>`.
The canary costs one extra model call per run. **MCP servers you connect to `agy` are not covered
by the rule**: a reviewer can call their tools.

### Output and exit codes

stdout is one marker line; progress, errors and the report path (`Report: <path>`) go to stderr.

```
PR marker: Cross-review: <reviewer>/<model|default> @ <sha7> (author: <id>) — <n> findings: <f> fixed, <r> rejected[ (fallback: <id> — <reason>; …)]
Spec marker: Spec-review: …        # with --spec
```

Put the text after `PR marker: ` into the PR description, or the text after `Spec marker: ` into
the spec header, and fill in `<f>` and `<r>` after triage. The count comes from the result line
and is not agreed with its noun (`1 findings`). Reviewers the chain never reached are not named.

| Exit | Meaning |
|---|---|
| 0 | reviewed; the marker is printed |
| 2 | a usage or config error; no review attempted, no marker |
| 3 | a nested run (`CROSS_REVIEW_ACTIVE=1`) |
| 5 | every eligible reviewer failed, or one timed out; the marker `failed (…)` is still printed |

### Run directories

Each attempt gets its own directory
`<tmpDir>/cross-review-[spec-]<reviewer>-<branch>-<sha7>-XXXXXX/` with `branch.diff` (diff
mode), `report.md`, `reviewer.log` and the snapshot worktree. The snapshot is removed when the
attempt ends (`git worktree remove --force`); a process killed from outside cannot do that, one
more reason to run it in the background.

**detent never deletes the run directories.** They pile up in `tmpDir`, which must stay in
`.gitignore`, or the next run refuses with `working tree is dirty`. Clean them with a script, per
the constitution's deletion rule: literal paths, a dry-run shown to the owner first, never an
inline command, never in the background.

## Windows

- The CLI looks reviewers up in `PATH` × `PATHEXT` itself and spawns them without a shell. A
  `codex` or `claude` installed through npm is a `.cmd` shim, which cannot be spawned without a
  shell, so detent unwraps an npm-format shim into `node <script>`, as the shim itself would; the
  prompt still arrives as one argument, byte for byte. A `.cmd` or `.bat` that does not look like
  an npm shim fails as `unrecognised .cmd shim at <path>`, and the chain moves on. Native
  executables (`agy.exe`, `claude.exe` from the native installer) are spawned directly.
- `agy.exe` installs into `%LOCALAPPDATA%\agy\bin` and is added to the user `PATH` only, so a
  shell started before the install does not see it; the `not installed` reason names this place.
  Restart the shell (or the agent) after installing `agy`.

## Known limits

What release 1 has and has not proved, from the spec's claim → evidence table and probes:

- **Skill pickup**: Codex 0.166 and `agy` 1.4.12 see all four `detent-*` skills in
  `.agents/skills/` and each picks its own `--author` value (probed in WSL). Claude Code picking
  up `.claude/skills/` rests on its documentation and has not been checked live.
- **The `claude` reviewer's read-only** was probed with Claude Code 2.1.316 on Windows and WSL:
  with the adapter's flags the session has only `Read`, `Grep` and `Glob`, no file appeared in the
  repository, the run directory or outside them, and `--restricted` blocked reading outside the
  two. A full review by `claude` has not been run (for a Claude author the family rule excludes it).
- **The plugin's skill names** are not verified: Claude Code may name them by directory
  (`detent:design-spec`) or by the frontmatter `name` (`detent:detent-design-spec`).
- **"Reviewed by Gemini 4 Argon"** is the `agy` CLI's claim: it accepts `--model` and refuses an
  unknown model, but its response does not name the model that answered.
- **The author** in the marker is the caller's claim, and `<f> fixed, <r> rejected` is the
  author's self-report.
- **`agy` read-only** is proved for `write_file`/`edit_file` only, and only while `agy` keeps the
  rule's syntax; the canary catches a change, MCP tools stay uncovered.
- **npm** 11.19+ prints an `install-scripts … not yet covered by allowScripts` warning for
  detent's `prepare` script. The build still runs; if npm makes this blocking, `dist/` will have to
  be committed into the release tag.
- **Install from git** was tried with `npm i -D` on Windows and WSL. The lock file records the
  dependency as `git+ssh://git@github.com/…`; a machine without an SSH key for GitHub has not been
  tried. The one-off `npx -y github:ysilvestrov/detent#v0.1.0 --version` printed `0.1.0` on both.
- The `codex` reviewer has not been run on Windows.
