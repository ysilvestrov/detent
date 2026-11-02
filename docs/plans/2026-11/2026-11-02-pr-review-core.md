# AI-рев'ю PR, ядро: план реалізації

> **Для агентів:** ОБОВ'ЯЗКОВИЙ СКІЛ: superpowers:subagent-driven-development або superpowers:executing-plans. Кроки позначено чекбоксами (`- [ ]`).

**Мета:** команда `detent pr-review` проводить двоетапне рев'ю PR через одного з трьох постачальників і публікує його в GitHub, а `--replay` робить те саме локально без публікації.

**Архітектура:** модулі рев'ю warsaw-beer-bot переносяться в `src/pr-review/` майже без змін (задача 1). Постачальники й конфіг додаються поруч (задача 2), оркестрація читає настройки з базової гілки й веде `scope` у стані (задача 3), команда з'єднує все це з CLI (задача 4).

**Стек:** TypeScript (ESM, `nodenext`), Node ≥ 20, вбудований `fetch`, vitest.

**Спека:** `docs/specs/2026-11/2026-11-02-pr-review-design.md`

Це план ядра за `detent-pr-slicing`. Action, документація, версія й випуск (PR 2), а також перехід warsaw-beer-bot (PR 3) — окремий план, який пишеться після наскрізного рев'ю ядра.

Джерело перенесення: `C:\Projects\warsaw-beer-bot`, `origin/main` 12c7346e; локальна копія файлів рев'ю збігається з ним (П-1). Шляхи нижче `scripts/...` — звідти.

## Глобальні обмеження

- Без залежностей під час роботи: `dependencies` у `package.json` не з'являються, `zod` не переноситься.
- Node ≥ 20, лише вбудовані модулі.
- Жодного рекурсивного чи автоматичного видалення (правило 8 конституції). Тести створюють теки через `mkdtempSync` і не видаляють їх; `test-temp.ts` із warsaw-beer-bot не переноситься, бо в ньому `rmSync`.
- Без змін: маркери `<!-- ai-pr-review -->`, `<!-- ai-pr-review-state `, `<!-- ai-pr-review-failure -->`, `v: 1` і наявні поля стану, ліміти й константи (`CONTEXT_BUDGET`, `MAX_OPEN_FINDINGS`, `MAX_BODY_CHARS` тощо).
- Логіка етапів не змінюється. Коментарі з вимірюваннями лишаються; посилання `#NNN` стають `warsaw-beer-bot#NNN`.
- Код виходу: 0, 2, 5, як у спеці. `src/review/` не змінюється.
- Текст файлів `prompts/` проходить заборону зі `src/content.test.ts`: `warsaw`, `beer`, `deploy:hold`, `orphan`, `sqlite`.

## На що дивитись на рев'ю

Кожен рядок має тест у названій задачі.

1. Немає `origin/<база>` (неповний checkout): код 2 із назвою ref, а не тихий перехід на типові настройки (задача 3).
2. PR із порожнім описом: GitHub надсилає `body: null`, рев'ю проходить, а не падає й не друкує `null` (задача 4).
3. Ключ API не з'являється ні в тексті помилки, ні в коментарі про збій, ні в журналі, навіть коли HTTP-відповідь містить його (задача 2).
4. База з `/` у назві (`release/1.0`): настройки читаються, режим визначається (задача 3).
5. Fork, з якого видалено репозиторій: `head.repo` є `null`, це вважається форком, код 0 без ключа (задача 4).

---

### Задача 1: перенесення етапів один до одного

**Файли:**
- Створити: `src/pr-review/{types,usage,openai,validate,gate,context,state,find,verify,incremental,render}.ts`
- Тести: `src/pr-review/{usage,openai,validate,gate,context,state,find,verify,incremental,render}.test.ts`

**Інтерфейси:**
- Дає: ті самі експорти, що в `scripts/ai-review/*`, плюс `validate.ts`.
- `validate.ts`: `isFindings(v: unknown): v is { findings: RawFinding[] }`, `isVerdicts(v: unknown): v is { verdicts: Array<{ index: number; verdict: 'confirmed' | 'refuted' | 'out_of_scope'; evidence: string }> }`, `isReviewState(v: unknown): v is ReviewState`.
- `openai.ts`: `OpenAiDeps` дістає необов'язкові `providerName?: string` (типово `'OpenAI'`, замість слова OpenAI в повідомленнях) і `extraBody?: Record<string, unknown>`, що дописується в тіло **після** наявних полів, щоб запит OpenAI лишився байт у байт.
- Поля, які відсутні в схемі, валідатори не перевіряють; `parseState`, `runFind` і `verifyFile` повертають лише відомі поля, як `zod.object`.

- [ ] **Крок 1: перенести тести.** Скопіювати `scripts/ai-review/{usage,openai,gate,context,state,find,verify,incremental,render}.test.ts`, змінивши лише шляхи імпорту (`./x` → `./x.js`). Очікування не міняти, крім тексту помилок про схему, де згадано формулювання `zod`.

- [ ] **Крок 2: написати `validate.test.ts`.** На кожен валідатор: правильний об'єкт `true`; нецілий `start_line`, нецілий `spend.runs`, `severity: 'P3'`, `verdict: 'error'`, `v: 2`, масив замість об'єкта, `null` — усе `false`.

- [ ] **Крок 3: переконатися, що тести падають.**

Запуск: `npx vitest run src/pr-review`
Очікування: FAIL, модулів немає.

- [ ] **Крок 4: перенести модулі.** Скопіювати `scripts/ai-review/{types,usage,openai,gate,context,state,find,verify,incremental,render}.ts`. Зміни: імпорти на `.js`; `import { z } from 'zod'` і схеми `zod` → виклики `validate.ts`; додаткові поля `OpenAiDeps` як вище. Решту логіки не чіпати. Файли `replay.ts` і `verify-corpus*` не переносити.

- [ ] **Крок 5: тести й типи.**

Запуск: `npx vitest run src/pr-review` і `npm run typecheck`
Очікування: PASS, без помилок типів.

- [ ] **Крок 6: коміт.** `feat(pr-review): port the review stages like for like`

### Задача 2: постачальники й конфіг

**Файли:**
- Створити: `src/pr-review/providers.ts`, `src/pr-review/providers.test.ts`
- Змінити: `src/config.ts`, `src/config.test.ts`

**Інтерфейси:**
- Дає, у `providers.ts`:
  - `PROVIDER_IDS = ['openai', 'anthropic', 'openrouter'] as const`, `type ProviderId`, `isProviderId(id: string): id is ProviderId`.
  - `interface Provider { id: ProviderId; name: string; endpoint: string; keyEnv: string; defaultModels?: { find: string; verify: string }; extraBody?: Record<string, unknown> }`, `PROVIDERS: Record<ProviderId, Provider>`.
  - `selectProvider(configured: ProviderId | undefined, env: Env): { kind: 'ok'; provider: Provider; apiKey: string } | { kind: 'no-key'; wanted: string } | { kind: 'ambiguous'; keys: string[] }`.
  - `resolveModels(provider: Provider, configured: { findModel?: string; verifyModel?: string }): { ok: true; find: string; verify: string } | { ok: false; error: string }`.
- Дає, у `config.ts`: `Config.prReview?: PrReviewConfig`, де `interface PrReviewConfig { provider?: ProviderId; include?: string[]; ignore?: string[]; bodyExclude?: string[]; bodyInclude?: string[]; findModel?: string; verifyModel?: string }`. Поле необов'язкове, щоб наявні `toStrictEqual` на конфігу лишилися чинними.

- [ ] **Крок 1: написати тести.**

```ts
test('table', () => {
  expect(PROVIDERS.openai).toMatchObject({ endpoint: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', defaultModels: { find: 'gpt-5.6-sol', verify: 'gpt-5.5' } });
  expect(PROVIDERS.anthropic).toMatchObject({ endpoint: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' });
  expect(PROVIDERS.openrouter).toMatchObject({ endpoint: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', extraBody: { provider: { require_parameters: true } } });
});
```

`selectProvider`: один ключ обирає свого; `configured` + свій ключ — `ok`, навіть коли задано й інші; `configured` без свого ключа — `no-key` з `wanted: 'ANTHROPIC_API_KEY'`; два ключі без `configured` — `ambiguous` з обома іменами; жодного — `no-key`; порожній чи пробільний рядок не вважається ключем.

`resolveModels`: `openai` без настройок дає `gpt-5.6-sol`, `gpt-5.5`; `anthropic` без `findModel` — `ok: false`, помилка містить `prReview.findModel`.

`callStructured` з `extraBody` постачальника OpenRouter: у тілі є `provider.require_parameters`; для OpenAI цього поля немає, а `JSON.stringify` тіла збігається із зафіксованим рядком. Запит іде на `<endpoint>/chat/completions`.

Рядок 3 із «На що дивитись»: `fetch`-заглушка віддає 401 із тілом, що містить сам ключ; `callStructured` кидає помилку, у якій ключа немає. Для цього `callStructured` замінює значення ключа на `***` у всьому тексті помилок.

`parseConfig`: валідний `prReview` зберігається; відсутній — поля `prReview` немає в результаті; невідомий ключ у `prReview` — помилка з його назвою (`detent.json: unknown key "endpoint" in "prReview"`); `provider: 'x'`; `include: 'a'`; `include: [1]`; `findModel: ''` — кожне дає `ok: false`.

- [ ] **Крок 2: переконатися, що тести падають.**

Запуск: `npx vitest run src/pr-review/providers.test.ts src/config.test.ts src/pr-review/openai.test.ts`
Очікування: FAIL.

- [ ] **Крок 3: реалізувати** `providers.ts`, `prReview` у `parseConfig`, заміну ключа в помилках `callStructured`.

- [ ] **Крок 4: тести.**

Запуск: `npx vitest run src/pr-review src/config.test.ts src/examples.test.ts`
Очікування: PASS.

- [ ] **Крок 5: коміт.** `feat(pr-review): providers and the prReview config`

### Задача 3: оркестрація, настройки з бази, `scope`

**Файли:**
- Створити: `src/pr-review/review.ts` (із `scripts/ai-pr-review.ts`), `src/pr-review/settings.ts`, тести `review.test.ts`, `settings.test.ts`
- Змінити: `src/pr-review/state.ts`, `src/pr-review/validate.ts`, `src/pr-review/incremental.ts`, `src/pr-review/render.ts` і їхні тести

**Інтерфейси:**
- Споживає: задачі 1 і 2.
- Дає, у `settings.ts`:
  - `DEFAULT_PATTERNS = { include: ['**'], ignore: ['**/*.md', 'docs/**', 'package-lock.json'], bodyExclude: ['**/*.test.*', 'tests/**'], bodyInclude: [] }`.
  - `interface ReviewSettings { patterns: FilePatterns; findPrompt: string; verifyPrompt: string; scope: string; configured: PrReviewConfig }`.
  - `loadSettings(read: (path: string) => string | null): ReviewSettings`: читає `detent.json` і `.detent/prompts/pr-review-{find,verify}.md`, а якщо їх немає, бере промпти з пакета; кидає `ConfigError` на зламаний конфіг чи невідомий плейсхолдер. Заповнює `{{reviewContext}}` через `renderPrompt`; без `reviewContext` — `none stated`, як у `cross-review`.
  - `baseReader(cwd: string, baseRef: string): (path: string) => string | null`: `git rev-parse --verify origin/<база>` падає — `ConfigError` із назвою ref; файла на базі немає — `null`.
  - `scope` = перші 16 символів sha256 від `JSON.stringify([prReview ?? null, reviewContext ?? null, findPrompt, verifyPrompt])`.
- Дає, у `review.ts`: `runReview(pr: PrContext, run: RunSettings, deps: ReviewDeps): Promise<void>`, де `PrContext = { repo, prNumber, baseRef, prTitle, prBody, githubToken }`, `RunSettings = { settings: ReviewSettings; provider: Provider; apiKey: string; findModel: string; verifyModel: string }`, `ReviewDeps` як у warsaw-beer-bot без `readInstructions`. Експортує також `findExistingReview`, `upsertReview`, `partitionPrFiles`, `filterReviewableFiles(files, patterns)`, `isBodyExcluded(path, patterns)`, `readReviewableFile`, `MARKER`, `FAILURE_MARKER`.
- `decideMode` дістає параметр `scope: string`. `ReviewState` дістає `scope?: string`; `renderBody` приймає `scope` і записує його в стан.

- [ ] **Крок 1: перенести тести `scripts/ai-pr-review.test.ts`** у `review.test.ts`. Переліки warsaw-beer-bot стають фікстурою `const PATTERNS: FilePatterns` на початку файлу, включно з винятком `scripts/ops/test_run.py` у `bodyInclude`. Очікування не змінювати, крім: тексту збою (без «required»), `User-Agent`, викликів із `pr`, `run`, `deps`. Блок `readConfig` не переноситься. Сканування викликів `buildReviewContext` переспрямувати на `src/pr-review`.

- [ ] **Крок 2: написати нові тести.**
  - `decideMode`: стан зі `scope: 'a'`, поточний `'b'`, та сама голова — `mode: 'full'`, `reason` містить `settings changed`. Стан зі `scope: 'a'` і поточний `'a'` — як було. Стан без `scope` — звичайне рішення за головою (republish, incremental).
  - `parseState`: зразок живого стану без `scope` читається без втрат (зафіксований рядок із PR #939, знахідки анонімізувати не потрібно, репозиторій публічний); `scope: 1` дає `null`.
  - `settings.test.ts` на справжньому git-репозиторії в `mkdtempSync` (`origin/<база>` створюється через `git update-ref`): голова має інший `detent.json` і промпт — читається версія бази; база `release/1.0` читається (рядок 4); немає ref — `ConfigError`, текст містить `origin/main` (рядок 1); немає файлу — типові значення; `{{nope}}` у промпті — `ConfigError`; зміна будь-якого з чотирьох складників змінює `scope`.

- [ ] **Крок 3: переконатися, що тести падають.**

Запуск: `npx vitest run src/pr-review`
Очікування: FAIL на нових і перенесених тестах.

- [ ] **Крок 4: реалізувати.** `review.ts`: скопіювати оркестрацію, замінити константи переліків на `run.settings.patterns`, `readInstructions` на промпти з `settings`, `openaiDeps` на `{ endpoint, apiKey, providerName, extraBody }` постачальника, `isBodyExcluded` на `bodyExclude` мінус `bodyInclude`, `User-Agent` на `detent-pr-review`. `main`, `readConfig` і `require.main` не переносити.

- [ ] **Крок 5: тести й типи.**

Запуск: `npx vitest run src/pr-review` і `npm run typecheck`
Очікування: PASS.

- [ ] **Крок 6: коміт.** `feat(pr-review): orchestration, settings from the base branch, scope`

### Задача 4: команда `detent pr-review`

**Файли:**
- Створити: `src/commands/pr-review.ts`, `src/commands/pr-review.test.ts`, `src/pr-review/replay.ts`, `src/pr-review/replay.test.ts`, `src/pr-review/index.ts`, `prompts/pr-review-find.md`, `prompts/pr-review-verify.md`
- Змінити: `src/cli.ts`, `src/content.test.ts` (за потреби лише перелік), `package.json` (`exports`), `scripts/smoke.mjs`

**Інтерфейси:**
- Споживає: задачі 1–3.
- Дає: `prReview(argv: readonly string[], io: PrReviewIo): Promise<number>`, `PrReviewIo = { cwd, env, out, err, fetchFn? }`, `EXIT = { ok: 0, usage: 2, failed: 5 }`, `USAGE`.
- `index.ts` реекспортує для warsaw-beer-bot: `verifyAll`, `costUsd`, `addUsage`, `EMPTY_USAGE`, `DEFAULT_MAX_COMPLETION_TOKENS`, `runReview` і типи. Заголовний коментар: імпорт нестабільний.
- `package.json`: `"exports": { "./pr-review": "./dist/pr-review/index.js", "./package.json": "./package.json" }`.

- [ ] **Крок 1: написати тести `pr-review.test.ts`.** Подія читається з файлу `GITHUB_EVENT_PATH` у `mkdtempSync`; `fetchFn` — заглушка, git-репозиторій справжній.
  - `GITHUB_EVENT_NAME: 'push'` — код 2.
  - Немає `GITHUB_EVENT_PATH` чи `GITHUB_TOKEN` — код 2.
  - Форк без ключа — код 0, у `err` є `fork`, викликів `fetch` немає.
  - `head.repo: null` без ключа — код 0 (рядок 5).
  - Не форк без ключа — код 5.
  - Два ключі без `provider` — код 2, повідомлення називає обидва.
  - `provider: 'anthropic'` на базі без `findModel`, ключ заданий — код 2, викликів `fetch` немає.
  - `body: null` — код 0, у запиті до моделі `(no description)` (рядок 2).
  - Модель відповідає 500 — код 5, коментар про збій опублікований, ключа в ньому немає.
  - У CI `AI_REVIEW_MODEL=evil` не змінює `model` у запиті; у `--replay` змінює.

- [ ] **Крок 2: написати `replay.test.ts`.** Перенести `resolveReplayArgs` і `ensureHeadCommit` із `scripts/ai-review/replay.test.ts`, замінивши позиційний `base-sha` на `--base <sha>`; додати `--provider x` — помилка з переліком постачальників.

- [ ] **Крок 3: переконатися, що тести падають.**

Запуск: `npx vitest run src/commands/pr-review.test.ts src/pr-review/replay.test.ts`
Очікування: FAIL.

- [ ] **Крок 4: написати промпти.** `prompts/pr-review-find.md` і `pr-review-verify.md` — із `.github/ai-review/AGENTS.md` і `VERIFY.md`: замість назви проєкту рядок `Project context: {{reviewContext}}`; у «What counts» прибрати scraping, persistence, matching, bot runtime; решта без змін, зокрема мовні патерни. Посилання на дату вимірювання у `VERIFY.md` лишається.

- [ ] **Крок 5: реалізувати.**
  - `commands/pr-review.ts`: порядок перевірок — аргументи, подія й токен (код 2), `baseReader` + `loadSettings` (код 2), `selectProvider` (ambiguous — код 2; no-key: форк — код 0, інакше код 5 і коментар про збій), `resolveModels` (код 2), далі `runReview` (будь-який виняток — код 5).
  - `replay.ts`: перенесена логіка `replay.ts`, настройки через читання робочого дерева замість `baseReader`, моделі з `AI_REVIEW_MODEL` і `AI_REVIEW_VERIFY_MODEL`, постачальник із `--provider`. Друкує підсумок як нинішній `replay.ts` плюс `formatCostLine`.
  - `cli.ts`: маршрут `pr-review`; `main` може повернути `Promise<number>`, код виходу встановлюється після нього. Рядок у `USAGE`.
  - `smoke.mjs`: `detent(['pr-review'], { code: 2 })` із порожнім оточенням подій (`GITHUB_EVENT_NAME` прибрати з `detentEnv`), перевірка `stderr` містить `pull_request`.

- [ ] **Крок 6: gate і smoke.**

Запуск: `npm run gate`, далі `npm run smoke`
Очікування: обидва код 0. Перевірка `exports`: `bin` працює зі встановленого архіву, `import('@ysilvestrov/detent/pr-review')` із теки-споживача дає `verifyAll` типу `function`; цю перевірку додати в `smoke.mjs`.

- [ ] **Крок 7: коміт.** `feat(pr-review): the pr-review command and --replay`

- [ ] **Крок 8: наскрізне рев'ю ядра.** Прочитати `src/pr-review/` і команду цілком, а не по задачах, проти спеки. Знахідки записати в кінець цього плану. Потім писати план PR 2 і PR 3. Рішення, що змінює розділ власника у спеці, зупиняє роботу: це поправка, яка повертає спеку на затвердження.
