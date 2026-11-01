# План ядра релізу 1: CLI `detent cross-review`

Дата: 2026-11-01
Спека: [docs/specs/2026-11/2026-11-01-release-1-design.md](../../specs/2026-11/2026-11-01-release-1-design.md)
(затверджено; поправки власника від 2026-11-01, зокрема дірки, знайдені при цьому плануванні)
Гілка: `feat/cross-review-core`

## Що є ядром

За `detent-pr-slicing` зі спеки: план більший за ~4 задачі, тож спершу ядро, потім наскрізне
рев'ю, а вже тоді окремий план на обв'язку. Ядро — механізм, на який спирається решта:

- протокол рев'ю (`src/review/protocol.ts`): промпт, рядок результату, маркер, причина;
- адаптери `codex`, `claude`, `agy` і правило «рецензент ≠ автор» за родиною моделі;
- вибір рецензента й ланцюжок до першого успіху; таймаут ланцюжок зупиняє;
- канарка `agy` перед кожним його запуском;
- раннер CLI (`src/review/cli-runner.ts`): знімок-worktree, таймаут 15 хв, закритий stdin,
  `CROSS_REVIEW_ACTIVE`, пошук бінарника, розгортання npm-шима на Windows;
- узагальнені промпти `prompts/review-{diff,spec}.md` з перекриттям `.detent/prompts/`;
- каркас пакета: `package.json` (`bin: detent`, нуль runtime-залежностей, `prepare` → `tsc`),
  роутер `src/cli.ts` з `cross-review` і `--version`.

**Не входить (план обв'язки, після рев'ю ядра):** скіли, шаблон конституції, `install`,
плагін Claude, `examples/`, README з установкою, проба «установка з git-тегу в чистий проєкт +
`npx detent --version`» на обох ОС. Цю пробу спека ставить на початок плану, але вона
перевіряє доставку, а доставка — частина обв'язки. До того ж їй потрібен тег на GitHub.

## Рішення, взяті зі спеки (щоб виконавець не вирішував сам)

- **Модуль**: ESM (`"type": "module"`), `module`/`moduleResolution: nodenext`, Node ≥ 20.
  Шляхи — лише через `node:path`; шлях до `prompts/` — від `import.meta.url` (`dist/…` → `../prompts`).
- **Конфіг**: `detent.json` у корені репо. Немає файлу → дефолти зі спеки («Конфіг проєкту»).
  Є файл → поверхневе злиття з дефолтами. Битий JSON, невідомий id у `reviewers`, порожній рядок
  у `models` або тип не той — помилка конфігу, exit 2. Невідомі ключі верхнього рівня
  ігноруються: їх читає обв'язка (`gate`, `specFile`, `plansDir`).
- **Причини**: `classifyRun` повертає причину без імені рецензента; `<id>: ` додає ланцюжок,
  тож `failed (author: claude; codex: timeout after 15 min)`, а не `codex: codex: …`.
- **Маркер**: формат з поправки власника — автор у дужках, `default` замість не заданої моделі.
- **Збій усередині спроби** (виняток при `worktree add`, запис файла) — збій цієї спроби з
  `markerReason(error.message)`; ланцюжок іде далі (це не таймаут).
- **Порядок перевірок CLI**: вкладений запуск (exit 3) → аргументи (2) → читання git (2) →
  конфіг (2) → ланцюжок (2) → шлях спеки (2) → брудне дерево / порожній diff / спека не в
  `HEAD` (2) → шаблон промпту (невідомий плейсхолдер — 2) → ланцюжок спроб (0 або 5).
- **Таймаут** — параметр раннера (`timeoutMs`), CLI передає 900 000. Публічного прапорця чи
  змінної середовища немає; тест викликає функцію команди напряму з малим таймаутом.

## Задачі

Оцінка розміру — до диспатчу, за `detent-pr-slicing`: інлайн лише якщо (а) у тексті повний код,
(б) ≤ 2 файли плюс тести, (в) не потрібне нове рішення.

### Задача 1. Каркас пакета й протокол — **диспатч** (кілька файлів каркаса, коду в тексті немає)

Файли: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`,
`vitest.config.ts`, `.gitignore` (+`dist/`, `tmp/`), `src/review/protocol.ts`,
`src/review/protocol.test.ts`.

- `package.json`: `name: "detent"`, `version: "0.1.0"`, `type: module`, `bin: { detent: "dist/cli.js" }`,
  `files: ["dist", "prompts"]`, `engines.node >= 20`, без `dependencies`; devDependencies —
  `typescript`, `vitest`, `@types/node`. Скрипти: `build` (`tsc -p tsconfig.build.json`),
  `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `prepare` (`npm run build`),
  `gate` (`npm run typecheck && npm test && npm run build`).
- `protocol.ts` нічого не знає про процеси (спека, «Під реліз 2»). Експортує:
  - `type Mode = 'diff' | 'spec'`; `type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string }`;
  - `classifyResult(report: string): Verdict` — останній рядок після `trimEnd` мусить точно
    збігатися з `/^CROSS-REVIEW-RESULT: (\d+) findings?\s*$/`; інакше
    `output does not end with a CROSS-REVIEW-RESULT line`;
  - `markerReason(text)` — порт warsaw без змін (перший непорожній рядок, 200 кодових точок, `…`, `unknown error`);
  - `renderPrompt(template, vars)` — порт warsaw (`Object.hasOwn`, `unfilled placeholder {{x}}`);
  - `successBody({ reviewer, model?, sha7, author, findings, fallbacks: { reviewer, reason }[] })` →
    `codex/gpt-6.1-sol @ abc1234 (author: claude) — 2 findings: <f> fixed, <r> rejected`,
    з ` (fallback: codex — <reason>; …)`, коли `fallbacks` непорожні; без моделі — `claude/default`;
    кожна причина проходить `markerReason`;
  - `failedBody(author, failures)` → `failed (author: claude; codex: <reason>; agy: <reason>)`;
  - `markerLine(mode, body)` → `PR marker: Cross-review: …` / `Spec marker: Spec-review: …`.
- Тести — порт відповідних тестів warsaw `core.test.ts` плюс нові для `successBody`/`failedBody`:
  без моделі, один і два fallback, обрізання довгої причини, `1 findings` (рядок маркера не
  узгоджує число — так у спеці).

### Задача 2. Узагальнені промпти — **інлайн** (повний текст нижче, 2 файли + тест, рішень немає)

Файли: `prompts/review-diff.md`, `prompts/review-spec.md`, `src/review/prompts.test.ts`.

Плейсхолдери diff: `project branch sha base diffPath specsDir plansDir specFile reviewContext`;
spec: `project specPath branch sha specFile reviewContext`. Без `reviewContext` у конфігу
підставляється `none stated`. Текст — порт warsaw з такими змінами: «warsaw-beer-bot» →
`{{project}}`; шляхи спек/планів → `{{specsDir}}`/`{{plansDir}}`; кореневий `spec.md` → `{{specFile}}`;
«Testing bullet in CLAUDE.md» → правила тестів, наведені в самому промпті (промпт самодостатній),
плюс блок конституції detent у `CLAUDE.md`/`AGENTS.md`; `docs/spec-format.md` → `spec-format.md`
скіла `detent-design-spec`; обмеження «one host, SQLite, $20–40/month» → `{{reviewContext}}`;
перелік у перевірці «Reinvention» — без systemd/litestream/sqlite. Повний текст:

`prompts/review-diff.md`:

````markdown
You are reviewing a branch of the {{project}} repository before its pull request opens.
You are read-only: do not try to change any file. Your report is read by the author, who will
verify each finding before acting on it.

Branch: {{branch}} at {{sha}}, compared with {{base}}.
The full diff is in the file {{diffPath}}. Read it first. You may open any file in the
repository for context. In particular, read the branch's own spec and plan under {{specsDir}}/
and {{plansDir}}/ (the files this diff adds or touches), the root {{specFile}} where the change
touches the product's behaviour, and the detent constitution block in CLAUDE.md or AGENTS.md.
Project context: {{reviewContext}}

Report only:
1. Correctness defects: give file:line and a concrete failure scenario (input/state → wrong output or crash).
2. Divergence from the branch's spec/plan or from {{specFile}}.
3. Test-quality violations: weak assertions where an exact one is possible, conditional logic in
   tests, tautological tests or tests that check a mock's state instead of the code, missing
   boundary/empty-input/error cases, expected values computed by re-implementing production logic.
4. Claim→evidence gaps: places where the code records something as fact (a state row, cursor,
   cache, verdict, marker) that the code does not actually prove.

Do not report style, naming, or formatting preferences. Do not report something you have not
checked in the code: quote the line you are talking about. If you are unsure, say so in the finding.

Format: a numbered list, one finding per item, most severe first. Then, as the very last line
of your answer, exactly:
CROSS-REVIEW-RESULT: <n> findings
where <n> is the number of findings (0 if none).
````

`prompts/review-spec.md`:

````markdown
You are reviewing a design spec of the {{project}} repository before its owner reads it.
You are read-only: do not try to change any file. Your report is read by the spec's author, who
will verify each finding and fix it or reject it with a reason before the owner approves the spec.

Spec: {{specPath}} on branch {{branch}} at {{sha}}.
Read, in this order: spec-format.md of the detent-design-spec skill (under .agents/skills/ or
.claude/skills/; the format the spec must follow), the spec itself, then the root {{specFile}}
and the code wherever the spec talks about them, and the detent constitution block in CLAUDE.md
or AGENTS.md for the project's rules.
Project context: {{reviewContext}}

The spec has two readers. The owner section at its top is for the owner, who approves the
spec from that section alone; the body is for whoever writes the plan. Your most important job is
to find what the owner would miss by reading only that section.

Report only:
1. Body → summary: a decision in the body that changes visible behaviour, the operational regime
   (what now happens without a human), access rights, or is irreversible, and that the owner
   section leaves out or blurs. Quote the body line. Do not report the other direction (a summary
   line the body repeats) unless the two contradict.
2. Premises: a premise without a source tag; a probe tag with no probe in the body; an inference
   tag on a premise that does not follow from what the spec gives.
3. Contradictions: the owner section and the body say different things (numbers, limits, who
   does what).
4. Claim→evidence: a place where the design records something as fact and the evidence is a
   count, an assumption about external data, or "it has always been so".
5. Reinvention: a place where the design builds its own mechanism and an existing one covers it —
   the platform the project runs on, git, `gh`, a dependency already in the project's manifest,
   or a module already in this repository. Name the concrete tool and what it would not cover; a
   finding that cannot name both is not reported.
6. Design defects: a scenario where the described mechanism gives a wrong result, with the
   concrete input or state.

Do not report style, wording, or "add more detail" without naming what is missing. Quote the spec
line you are talking about. If you are unsure, say so in the finding.

Format: a numbered list, one finding per item, most severe first, each tagged with its check
number (e.g. "[1]"). Then, as the very last line of your answer, exactly:
CROSS-REVIEW-RESULT: <n> findings
where <n> is the number of findings (0 if none).
````

`src/review/prompts.test.ts`:

````ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPrompt } from './protocol.js';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url)), 'utf8');
const diffVars = {
  project: 'acme', branch: 'feat/x', sha: 'abc1234', base: 'origin/main', diffPath: '/t/run/branch.diff',
  specsDir: 'docs/specs', plansDir: 'docs/plans', specFile: 'spec.md', reviewContext: 'one host, SQLite',
};
const specVars = {
  project: 'acme', specPath: 'docs/specs/2026-11/x-design.md', branch: 'main', sha: 'abc1234',
  specFile: 'spec.md', reviewContext: 'none stated',
};

describe('review-diff.md', () => {
  const out = renderPrompt(read('review-diff.md'), diffVars);
  test('names the project, the subject and the diff file', () => {
    expect(out.startsWith('You are reviewing a branch of the acme repository')).toBe(true);
    expect(out.includes('Branch: feat/x at abc1234, compared with origin/main.')).toBe(true);
    expect(out.includes('The full diff is in the file /t/run/branch.diff.')).toBe(true);
  });
  test('points at the configured spec and plan folders and the root spec', () => {
    expect(out.includes('under docs/specs/\nand docs/plans/')).toBe(true);
    expect(out.includes('the root spec.md where')).toBe(true);
  });
  test('carries the project context as given', () => {
    expect(out.includes('Project context: one host, SQLite\n')).toBe(true);
  });
  test('ends by demanding the result line', () => {
    expect(out.trimEnd().endsWith('CROSS-REVIEW-RESULT: <n> findings\nwhere <n> is the number of findings (0 if none).')).toBe(true);
  });
  test('the spec-mode variable set does not fill it', () => {
    expect(() => renderPrompt(read('review-diff.md'), specVars)).toThrow('unfilled placeholder {{base}}');
  });
});

describe('review-spec.md', () => {
  const out = renderPrompt(read('review-spec.md'), specVars);
  test('names the project and the spec under review', () => {
    expect(out.startsWith('You are reviewing a design spec of the acme repository')).toBe(true);
    expect(out.includes('Spec: docs/specs/2026-11/x-design.md on branch main at abc1234.')).toBe(true);
  });
  test('points at the spec format shipped with the design-spec skill', () => {
    expect(out.includes('spec-format.md of the detent-design-spec skill')).toBe(true);
  });
  test('carries the absent-context text as given', () => {
    expect(out.includes('Project context: none stated\n')).toBe(true);
  });
  test('ends by demanding the result line', () => {
    expect(out.trimEnd().endsWith('CROSS-REVIEW-RESULT: <n> findings\nwhere <n> is the number of findings (0 if none).')).toBe(true);
  });
  test('the diff-mode variable set does not fill it', () => {
    expect(() => renderPrompt(read('review-spec.md'), diffVars)).toThrow('unfilled placeholder {{specPath}}');
  });
});

describe('no project-specific text in the core prompts', () => {
  test.each(['review-diff.md', 'review-spec.md'])('%s mentions no warsaw, beer or SQLite', (name) => {
    expect(read(name).match(/warsaw|beer|sqlite/gi)).toBeNull();
  });
});
````

Тести: обидва шаблони рендеряться повним набором змінних і кожен містить свої шляхи й рядок
`CROSS-REVIEW-RESULT: <n> findings`; набір змінних diff не заповнює шаблон spec
(`unfilled placeholder {{specPath}}`); у шаблонах немає слів `warsaw`, `beer`, `SQLite`.

### Задача 3. Конфіг, аргументи, адаптери, вибір ланцюжка — **диспатч** (> 2 файлів)

Файли: `src/config.ts`, `src/review/args.ts`, `src/review/adapters.ts`, `src/review/select.ts`,
`src/review/preflight.ts` і їхні `*.test.ts`. Усе чисте, без I/O.

- `config.ts`: `DEFAULT_CONFIG` (зі спеки, плюс `reviewContext?`); `parseConfig(text: string | null)`
  → `{ ok: true; config } | { ok: false; error }` за правилами вище.
- `args.ts`: `parseCrossReviewArgs(argv, env)`. Прапорці `--author --reviewer --base --spec --model`;
  значення не може бути порожнім чи починатися з `--`; невідомий прапорець — помилка;
  `--author` інакше `DETENT_AUTHOR` (порожнє — як відсутнє; прапорець перемагає змінну);
  без автора — `--author claude|codex|agy (or DETENT_AUTHOR) is required: the author cannot be detected`;
  невідомий id автора чи рецензента — помилка з назвою; `--spec` + `--base` — помилка (текст warsaw);
  `--model` без `--reviewer` — `--model needs --reviewer: a model id belongs to one reviewer CLI`.
  `base` не заповнюється тут: дефолт — `baseBranch` з конфігу.
- `adapters.ts`: інтерфейс `ReviewerAdapter` зі спеки (§«Адаптер рецензента») і `ADAPTERS`.
  Команди — рівно з таблиці спеки; `agy` — `--settings '{"permissions":{"deny":["write_file(*)"]}}' --sandbox --model <m> --output-format text -p <prompt>`
  (усі прапорці до `-p`, П-А3); `agy` без моделі в `command` — виняток (вибір це виключає).
  `agy.canary`: ті самі прапорці й модель, промпт
  `Use the write_file tool to create the file <runDir>/canary containing the word canary. Do nothing else.`,
  `mustNotExist: <runDir>/canary` (через `path.join`). `acceptsModel`: `agy` — `startsWith('gemini-')`,
  решта — `true`. `errorLine`: `claude` stdout/`API Error:`/last, `codex` stderr/`ERROR:`/last,
  `agy` stderr/`error:`/first. `errorLineOf(adapter, stdout, stderr)` — перший або останній
  непорожній рядок потоку (розділювачі `\r\n|\r|\n`), якщо він починається з префікса.
  `familyOfAuthor`: claude → anthropic, codex → openai, agy → google.
- `select.ts`: `selectChain({ author, reviewer?, model?, config })` →
  `{ ok: true; chain: { id; model? }[] } | { ok: false; error }` за §«Вибір рецензента» і
  уточненням власника: явний рецензент — родина, `acceptsModel`, `agy` без моделі → помилка;
  без явного — фільтр по `config.reviewers` (дублікати — лише перше входження) з причиною для
  кожного виключеного (`same family as the author (anthropic)`, `experimental`,
  `model "x" is not accepted (agy takes gemini-* only)`, `no explicit model: its CLI default is unknown, so its family cannot be proved`);
  порожній — помилка `no eligible reviewer for author <a>: <id> — <reason>; …`.
- `preflight.ts`: порт `isNestedRun`, `preflight`, `specPreflight`, `normalizeSpecPath`,
  `runDirPrefix`, `runArtifacts` (через `path.join`); `specPathError(path, specsDir)` —
  `<specsDir>/<YYYY-MM>/<name>.md`, `specsDir` нормалізується (слеші, без `./` і кінцевого `/`),
  спецсимволи regex екрануються.

Тести — на кожну гілку, разом із межами: порожній `argv`, `DETENT_AUTHOR=''`, `reviewers: []`,
дублікати, `models.agy: "claude-opus-5-5"`, `models.claude: ""`, `specsDir` з `./` і `\`,
шлях спеки з `.` у `specsDir`, перший/останній рядок помилки для `agy`/`codex`.

### Задача 4. Раннер, ланцюжок, команда й роутер — **диспатч** (> 2 файлів, I/O)

Файли: `src/review/cli-runner.ts`, `src/commands/cross-review.ts`, `src/cli.ts`, тести
`src/review/cli-runner.test.ts`, `src/commands/cross-review.test.ts`, фікстура
`test/fixtures/fake-reviewer.ts`.

- `cli-runner.ts` — єдине місце зі `spawnSync`, worktree і таймаутом:
  - `findExecutable(cmd, { env, platform, isFile })` — PATH × PATHEXT на `win32`
    (`;`, дефолт PATHEXT `.COM;.EXE;.BAT;.CMD`, регістр не важить), PATH на POSIX (`:`, файл з `X_OK`);
  - `resolveNpmShim(shimPath, text, nodeExeExists)` → `{ cmd, prefixArgs: [script] } | null` за
    рядком `"%_prog%"  "%dp0%\<rel>" %*` (П-Д); `cmd` — `<dir>\node.exe`, якщо є, інакше `process.execPath`;
  - `launchPlan(found)`: `.cmd`/`.bat` → шим або збій `unrecognised .cmd shim at <path>`; інше — як є;
  - `spawnOutcome` — порт warsaw;
  - `classifyRun(adapter, { exitCode, timedOut, spawnError, report, stdout, stderr })` →
    `{ kind: 'ok'; findings } | { kind: 'failed'; reason; timeout: boolean }`: таймаут
    (`timeout after 15 min`, `timeout: true`) → spawn (`did not run to completion: X`) →
    ненульовий код (хвіст рядка помилки за `errorLineOf`, інакше `exited with code N`) →
    `protocol.classifyResult(report)`;
  - `classifyCanary(outcome, fileExists)`: файл є → `deny rule ineffective`; таймаут →
    `canary: timeout after 15 min` з `timeout: true`; spawn / ненульовий код → `canary …`; інакше ok;
  - `runChain(chain, attempt)` — чистий цикл: успіх → стоп; збій з `timeout` → стоп; інакше далі.
    Результат: `{ kind: 'ok'; reviewer; model?; findings; fallbacks } | { kind: 'failed'; failures }`;
  - `attempt(...)`: немає бінарника → `not installed` без процесу (для `agy` на `win32` додає
    `agy.exe is usually in %LOCALAPPDATA%\agy\bin; a shell started before the install does not see it`);
    інакше власна тека `mkdtemp(runDirPrefix(...))`, `git worktree add --detach <snapshot> <sha>`,
    канарка (якщо є в адаптері), рев'ю; `finally` — `git worktree remove --force` + `prune`.
    Спільне для обох процесів: `cwd` = знімок, `stdio: ['ignore','pipe','pipe']`, `timeout`,
    `killSignal: 'SIGKILL'`, `maxBuffer` 64 МБ, `env` = середовище + `CROSS_REVIEW_ACTIVE=1`, без shell.
    Лог (`reviewer.log`) і звіт (`report.md`; для `report: 'stdout'` — записаний stdout) — у теці запуску.
- `commands/cross-review.ts`: `crossReview(argv, { cwd, env, timeoutMs, out, err }) → exit code` у
  порядку перевірок вище. Проєкт — `name` з `package.json` у корені, інакше ім'я теки. Шаблон —
  `.detent/prompts/review-<mode>.md` у корені, інакше з пакета. Друкує прогрес у `err`, маркер у `out`.
- `cli.ts`: shebang `#!/usr/bin/env node`; `cross-review …` → `crossReview` з `TIMEOUT_MS`;
  `--version` → версія з `package.json` пакета; без команди, `--help` чи невідома команда — usage, exit 2.
- Тести:
  - чисті: `findExecutable` (порожній PATH, PATHEXT, регістр, порядок), `resolveNpmShim` на тексті
    шима з П-Д і на чужому `.cmd`, `classifyRun` і `classifyCanary` (зокрема `agy` exit 0 з порожнім
    stdout і `jetski:` у stderr → збій без рядка результату — спека вимагає закріпити),
    `runChain` з фейковою спробою (успіх першого; збій → успіх другого з fallback; таймаут зупиняє;
    усі впали; один елемент);
  - наскрізні (`crossReview` у тимчасовому git-репо, фейкові рецензенти в `PATH`): на POSIX фейк —
    скрипт з `#!/usr/bin/env node`, на Windows — npm-шим `.cmd` + `.js` (так тест проганяє розгортання
    шима; вибір формату — у фікстурі, не в тілі тесту). Сценарії: успіх (маркер, worktree прибрано,
    stdin закритий, `CROSS_REVIEW_ACTIVE=1` у рецензента); codex не встановлений → agy з fallback;
    канарка `agy` записала файл → збій `deny rule ineffective`, рев'ю не запускалось; таймаут codex
    зупиняє ланцюжок (agy не запускався); вкладений запуск → 3; брудне дерево, порожній diff → 2;
    `--spec` поза `specsDir` → 2; невідомий плейсхолдер у `.detent/prompts/` → 2.

## Гейт

`npm run gate` (typecheck, test, build) — після кожної задачі на Windows; перед PR — у WSL-копії
після `git fetch` + rebase на `origin/main`.

## Після реалізації

1. Наскрізне рев'ю ядра (всі чотири задачі, зокрема інлайнова 2) → `docs/plans/2026-11/2026-11-01-release-1-core-review.md`;
   на нього спирається план обв'язки.
2. Жива проба канарки `agy` у WSL і Windows: зібраний адаптер, справжній `agy`, файл не з'являється.
3. Rebase, гейт у WSL, PR, cross-review зібраним CLI (`--author claude`), маркер в описі PR.
