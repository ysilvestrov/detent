# AI-рев'ю PR, обв'язка: план реалізації

> **Для агентів:** ОБОВ'ЯЗКОВИЙ СКІЛ: superpowers:subagent-driven-development або superpowers:executing-plans. Кроки позначено чекбоксами (`- [ ]`).

**Мета:** будь-який проєкт вмикає рев'ю секретом і коротким workflow, а warsaw-beer-bot переходить на пакет один до одного.

**Архітектура:** композитна Action ставить пакет закріпленої версії в окрему теку й запускає `detent pr-review` з ядра. Перехід warsaw-beer-bot доводиться звіркою виходу старої й нової версій із заглушкою замість моделі.

**Стек:** GitHub Actions (композитна дія), Node, vitest.

**Спека:** `docs/specs/2026-11/2026-11-02-pr-review-design.md`

Починається від ядра, як воно є після наскрізного рев'ю (`docs/plans/2026-11/2026-11-02-pr-review-core.md`). Ядро йде в PR 1, задачі 1–2 цього плану в PR 2, задача 3 в PR 3.

## Глобальні обмеження

- Секрети не потрапляють у крок встановлення пакета. Ключ є лише в env кроку запуску.
- Код PR не виконується: без `npm ci` проєкту, встановлення пакета з `--ignore-scripts`.
- Перший крок Action: `actions/checkout@v7` з `ref: ${{ github.event.pull_request.head.sha }}`. Типовий ref за `pull_request` — merge-коміт, і тоді збережена голова ніколи не була б предком, а кожен запуск мовчки став би `full`.
- `action.yml` не входить у `files` пакета.
- Правило 8: нічого рекурсивно не видаляти. У warsaw-beer-bot лише `git rm` з буквальними шляхами.
- Випуск і злиття робить власник.

## На що дивитись на рев'ю

1. У `github.action_path` є пробіл: кроки беруть шляхи в лапки (задача 1).
2. PR із форка: секрети порожні, крок запуску доходить до команди, а вона дає код 0 (задача 1, вміст `action.yml`; поведінку команди вже покрито).
3. Тег Action і версія npm не збігаються: версія береться лише з `package.json` тієї самої ревізії Action (задача 1).
4. PAT замість `github.token`: у README сказано, що потрібен токен бота, інакше стан втрачається (задача 2).
5. На гілці warsaw-beer-bot `origin/main` ще не має настройок: звірка читає їх через `loadSettings` із читачем робочого дерева (задача 3).

---

### Задача 1: Action і приклад workflow

**Файли:**
- Створити: `action.yml`, `examples/pr-review.workflow.yml`, `src/action.test.ts`
- Змінити: `scripts/smoke.mjs`

**Інтерфейси:**
- Споживає: `detent pr-review`, коди виходу 0, 2, 5; змінні `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`.
- Дає: входи Action `openai-api-key`, `anthropic-api-key`, `openrouter-api-key`, `github-token` (типово `${{ github.token }}`).

- [ ] **Крок 1: написати тести `src/action.test.ts`.** YAML-парсера в залежностях немає, тож перевірка за точними рядками файлу:
  - `action.yml` містить `using: composite`, `ref: ${{ github.event.pull_request.head.sha }}`, `fetch-depth: 0`, `persist-credentials: false`, `node-version: 24`, `--ignore-scripts`, `npm i --prefix "$RUNNER_TEMP/detent"`, `dist/cli.js" pr-review`.
  - Рядки `*_API_KEY:` стоять лише після рядка кроку запуску: індекс першого більший за індекс `name: Review`.
  - Жоден рядок `action.yml` не містить `npm ci` чи `npx`.
  - `examples/pr-review.workflow.yml` містить `types: [opened, reopened, synchronize]`, `pull-requests: write`, `github.event.pull_request.user.login != 'dependabot[bot]'`, `cancel-in-progress: true`, `uses: ysilvestrov/detent@`, і не містить `pull_request_target`.

- [ ] **Крок 2: переконатися, що тести падають.**

Запуск: `npx vitest run src/action.test.ts`
Очікування: FAIL, файлів немає.

- [ ] **Крок 3: написати `action.yml`.** Кроки зі спеки, розділ «Action»: checkout, setup-node, `name: Install` (версія через `node -p "require(process.env.GITHUB_ACTION_PATH + '/package.json').version"`; шлях у лапках; без секретів), `name: Review` (`node "$RUNNER_TEMP/detent/node_modules/@ysilvestrov/detent/dist/cli.js" pr-review`, env `*_API_KEY` із входів, `GITHUB_TOKEN` із `github-token`). `shell: bash` у кожному `run`.

- [ ] **Крок 4: написати приклад workflow** за розділом «Action» спеки: `uses: ysilvestrov/detent@<SHA> # v0.4.0`, `openai-api-key: ${{ secrets.OPENAI_API_KEY }}`, коментар із двома іншими входами й про Dependabot.

- [ ] **Крок 5: доповнити `scripts/smoke.mjs`.** `action.yml` не в архіві (`requireFile` навпаки, перевірка `existsSync` дає `false` для встановленого пакета, `true` для кореня).

- [ ] **Крок 6: gate і smoke.**

Запуск: `npm run gate`, далі `npm run smoke`
Очікування: код 0.

- [ ] **Крок 7: коміт.** `feat(pr-review): the GitHub Action and an example workflow`

### Задача 2: документація й версія

**Файли:**
- Змінити: `README.md`, `constitution/constitution.md`, `skills/cross-review/SKILL.md`, `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `src/content.test.ts` за потреби, `docs/specs/2026-11/2026-11-02-pr-review-design.md` лише якщо текст не збігається.

- [ ] **Крок 1: тести.** У `src/content.test.ts`: правило 6 конституції містить `pr-review`; `skills/cross-review/SKILL.md` містить речення про те, що CI-рев'ю не замінює `cross-review`. `src/plugin.test.ts` уже вимагає збігу версій.

- [ ] **Крок 2: переконатися, що тести падають.**

Запуск: `npx vitest run src/content.test.ts`
Очікування: FAIL.

- [ ] **Крок 3: внести зміни.**
  - Правило 6: CI-рев'ю (`detent pr-review`) доповнює `cross-review`, не замінює його; правило родин стосується лише `cross-review`.
  - README, новий розділ `## AI PR review in GitHub`: підключення, таблиця постачальників, вибір постачальника, `prReview`, коди виходу, що не рецензується, `--replay`, перевизначення промптів, настройки діють лише з бази, токен має бути бота, нестабільний імпорт. Цифри warsaw-beer-bot лише як дані одного проєкту. Відомі обмеження: непроміряні Anthropic і OpenRouter (токени без доларів, reasoning), `.gitattributes`, PR із форків. Прибрати «Release 2 is planned…», уточнити «CI does not run the reviewers». У релізному списку перед публікацією: звірити таблицю цін, живий `--replay` на кожного постачальника.
  - Версія `0.4.0` у `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`.

- [ ] **Крок 4: gate і smoke.**

Запуск: `npm run gate`, далі `npm run smoke`
Очікування: код 0.

- [ ] **Крок 5: коміт.** `docs(pr-review): README, the constitution, version 0.4.0`

### Кроки власника між PR 2 і PR 3

1. Живий `--replay` на одному PR для кожного з трьох постачальників, з локальної збірки. Постачальник, що не пройшов схему, позначається непідтриманим у README.
2. Звірити таблицю цін, злити PR 2, поставити тег, опублікувати `0.4.0`.

### Задача 3: перехід warsaw-beer-bot (репозиторій warsaw-beer-bot, власний PR)

Виконується лише після публікації `0.4.0`.

**Файли (у warsaw-beer-bot):**
- Змінити: `detent.json`, `package.json`, `package-lock.json`, `.github/workflows/codex-review.yml`, `AGENTS.md`, `CLAUDE.md`, `spec.md`, `docs/ai-review-model-evaluation.md`, `scripts/ai-review/verify-corpus*.ts`, `tsconfig.scripts.json`
- Перемістити: `.github/ai-review/AGENTS.md` → `.detent/prompts/pr-review-find.md`, `.github/ai-review/VERIFY.md` → `.detent/prompts/pr-review-verify.md`
- Видалити через `git rm`, буквальними шляхами: `scripts/ai-pr-review.ts`, `scripts/ai-pr-review.test.ts`, `scripts/ai-review/{context,find,gate,incremental,openai,render,state,types,usage,verify,replay}.ts` і їхні `.test.ts`

- [ ] **Крок 1: звірка виходу, поки старий код ще є.** Одноразовий скрипт поза репозиторієм у `tmp/`. Обидві `runReview` отримують підставлені `openaiFetch` і `githubFetch` та git-функції на голові PR. Новій настройки дає `loadSettings` із `@ysilvestrov/detent/pr-review` з читачем робочого дерева гілки переходу. Заглушка пошуку цитує перший доданий рядок кожного файлу з diff, заглушка перевірки підтверджує все. Запускати на Linux або одним читачем для обох: `autocrlf` на Windows дасть хибні розбіжності. Набір: 5 реальних PR, серед них зі збереженим станом, push без змін, лише документація. Порівняти байт у байт тіла запитів до моделі й опубліковане рев'ю, вилучивши `,"scope":"…"`, а також `User-Agent` і текст про збій. Незбіг зупиняє перехід. Результат іде в опис PR.

- [ ] **Крок 2: перенести настройки й промпти.** `prReview` у `detent.json`: `include`, `ignore`, `bodyExclude` дослівно з констант `scripts/ai-pr-review.ts`, `bodyInclude: ["scripts/ops/test_run.py"]`. Промпти через `git mv`, без змін тексту.

- [ ] **Крок 3: замінити workflow.** Ім'я файлу, ім'я workflow і ім'я задачі `review` лишаються, зберігається коментар про Dependabot.

- [ ] **Крок 4: перемкнути інструменти корпусу** на `@ysilvestrov/detent/pr-review`. warsaw-beer-bot має `"type": "commonjs"` і `nodenext`; якщо статичний імпорт дає TS1479, узяти динамічний `import()` і `import type` із `resolution-mode`. Закріпити точну версію `0.4.0`. Оновити `ai-review-replay` у `package.json` на `detent pr-review --replay`, згадки в документах.

- [ ] **Крок 5: видалити старий код** через `git rm`, показавши власнику список.

- [ ] **Крок 6: gate warsaw-beer-bot і PR.**

Запуск: `npm run typecheck`, `npm test`
Очікування: код 0. Перший живий запуск на цьому PR: статус зелений, рев'ю опубліковане із загальними промптами; наступний push: режим `incremental` і настройки warsaw-beer-bot.

- [ ] **Крок 7: після злиття** дописати в спеку «Фактично» й запропонувати окрему спеку великого тестування.
