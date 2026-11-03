# Велике тестування AI-рев'ю, обв'язка: план реалізації

> **Для агентів:** ОБОВ'ЯЗКОВИЙ СКІЛ: superpowers:subagent-driven-development або superpowers:executing-plans. Кроки позначено чекбоксами (`- [ ]`).

**Мета:** `scripts/eval/` запускає партії відбору й етапу 2 проти стелі витрат, веде запис, знеособлює вихід для оцінювача й будує таблиці та кандидатів на профіль.

**Архітектура:** логіка лежить чистими функціями в `scripts/eval/lib/*.mjs` і покрита тестами; `funnel.mjs`, `anonymize.mjs`, `summary.mjs` — тонкі команди над нею. `funnel.mjs` запускає `node <detent>/dist/cli.js pr-review --replay ...` із теки warsaw-beer-bot, кожен запуск пише у власний тимчасовий запис, а `funnel.mjs` перевіряє його на ключі й аж тоді дописує в спільний.

**Стек:** Node ≥ 20, ESM `.mjs` без залежностей, вбудований `fetch`, vitest.

**Спека:** `docs/specs/2026-11/2026-11-03-pr-review-big-test-design.md`, розділи «Кандидати», «Зміни інструмента (PR 1)», «Середовище прогону», «Партії», «Етап 2», «Оцінка», «Правила профілів», «Приймання». Ядро: `docs/plans/2026-11/2026-11-03-pr-review-big-test-core.md`.

План стоїть на ядрі як воно є на `90746b2` і на знахідках його наскрізного рев'ю. Живого виклику в плані немає: перший платний запуск — партія 0 у пісочниці власника.

## Глобальні обмеження

- Без залежностей під час роботи. `scripts/` не входить у пакет: `files` у `package.json` не змінюється.
- Жодного рекурсивного чи автоматичного видалення. Тимчасові записи лишаються в `tmp/eval/` (тека в `.gitignore`) і видаляються вручну.
- Тести: точні значення, без умовної логіки, без повтору логіки продукту. Команди запускаються в WSL, тому жодних Windows-шляхів у коді; шляхи будуються через `node:path`.
- Ключі читає лише `funnel.mjs` із файла `--keys` і передає дочірньому процесу лише ключ його постачальника. Значення ключа не друкується й не записується.
- Код виходу команд: 0 — усе виконано; 2 — неправильний виклик чи відмова до витрат; 3 — зупинка на стелі; 4 — у рядку знайдено ключ; 5 — хоч один запуск упав.
- Витрати рахуються лише з рядків `call`. Запуск без рядка `run` чи з непорожнім `error` не оцінюється, крім запуску, позначеного `expectFailure`.

## На що дивитись на рев'ю

Кожен рядок має тест у названій задачі.

1. Дочірній процес убито посеред запуску: рядки `call` дописані й пораховані, рядка `run` немає, а останній рядок обірваний (задачі 2, 4).
2. Повторний виклик партії після зупинки не платить за вже виконане, а впалий запуск виконує знову й новим файлом (задачі 3, 4).
3. Ключ у рядку, зокрема обрізаний до початку на межі 200 символів, не потрапляє в спільний запис, витрати зберігаються, код 4 (задачі 2, 4).
4. Файл ключів з `export`, лапками, порожнім рядком чи без потрібного ключа: розбирається або дає код 2 до першого виклику (задача 2).
5. `--labels` із міткою, яка вибула за оцінкою, або партія без оцінки попередньої: код 2 без витрат (задача 3).

---

### Задача 1: каталог, пісочниця, тести в `scripts/`

**Файли:**
- Створити: `scripts/eval/candidates.json`, `scripts/eval/claude-sandbox.json`, `scripts/eval/lib/catalog.mjs`, `scripts/eval/lib/catalog.test.mjs`
- Змінити: `vitest.config.ts`, `src/pr-review/replay-run.test.ts`

**Інтерфейси:**
- Створює `candidates.json`: `{ baseline: {label, findModel, verifyModel, route}, candidates: [{label, model, route, only: string[] | null, tier: 'cheap'|'mid'|'expensive', price: {input, cachedInput?, cacheWrite?, output}, note?}], prices: {<model>: price}, prs: {<pr>: {head: string | null, input, output}}, corpus: string[], recallPrs: string[] }`. Мітка `label` збігається з id моделі з таблиці спеки без префікса; `model` — id постачальника, для `openrouter` із префіксом із таблиці. `only` порожній до партії 0.
- Створює `catalog.mjs`: `loadCatalog(text): Catalog` (кидає `Error` із назвою поля), `priceOf(catalog, model): Price | null` (точний збіг у `prices` чи кандидатах, потім найдовший id, який є початком `model`, бо у відповіді буває модель із датою).

Значення: 21 рядок таблиці спеки «Кандидати» з її цінами й рівнями; `prs`: `418` — голова `584aa661`, 41400/4600; `930` — голова `a5926a74`, 41400/4600; `344`, `348`, `352`, `356`, `358` — голова `null`, 41400/4600; `688` — `null`, 30000/3500; `895` — `null`, 10000/1500. Розміри крім #418 — оцінка для резерву, не вимір. `cachedInput` — лише там, де спека його називає чи `/endpoints` дасть на партії 0; `cacheWrite` для `gpt-5.6-sol` — 5, для `gpt-6.1-sol` — 2.5. У `prices` також `gpt-5.5` за $5/$30.

- [ ] **Крок 1: тести, що падають**

У `catalog.test.mjs`, на справжньому `candidates.json`: `loadCatalog` проходить; є 20 кандидатів і базлайн; `claude-haiku-5-5`: `route: 'anthropic'`, `tier: 'cheap'`, ціна 0.1/0.5; `kimi-k3.1-pro`: `model: 'moonshotai/kimi-k3.1-pro'`, `route: 'openrouter'`; рівні: 10 дешевих, 7 середніх, 3 дорогі. `priceOf(catalog, 'gpt-5.5-2026-01-01')` дає ціну `gpt-5.5`; `priceOf(catalog, 'невідома')` — `null`. На `loadCatalog('{}')` кидає `baseline`; кандидат без `route` кидає `route`.

- [ ] **Крок 2:** у `vitest.config.ts` `include` стає `['src/**/*.test.ts', 'scripts/**/*.test.mjs']`. `npx vitest run scripts/eval` — падає: немає `catalog.mjs`.

- [ ] **Крок 3:** написати `candidates.json`, `catalog.mjs`. `claude-sandbox.json` — дослівно JSON зі спеки, розділ «Середовище прогону».

- [ ] **Крок 4:** прибрати з `replay-run.test.ts` те, що рев'ю ядра лишило на обв'язку: умовну логіку в `repoWith` і `verdictCalls` (рядки 144, 515), `slice(0, 4)` (567) замінити точним переліком ключів, `stringContaining('disk full')` (493) точним значенням, невикористане повернення `head` у `replay` (111). Додати два тести: повтор за тіла `null` без гачка в `openai.test.ts`, збій запису на етапі пошуку в `replay-run.test.ts` (одне тіло запиту, відмова, `exit: 5`).

- [ ] **Крок 5:** `npm run gate` — зелений. Коміт `feat(eval): the candidate catalog, the sandbox settings, tests under scripts`

### Задача 2: запис, ключі, витрати

**Файли:**
- Створити: `scripts/eval/lib/records.mjs`, `scripts/eval/lib/records.test.mjs`

**Інтерфейси:**
- Використовує: `priceOf`, `Catalog` із задачі 1. Формат рядків — `src/pr-review/record.ts`; `funnel.mjs` додає до них `requestedModel`, `mode`, `attempt`, `findingsFile`.
- Створює: `parseKeys(text): Record<string, string>`; `parseRecords(text): Line[]` (обірваний лише останній рядок відкидається, зламаний посередині кидає з номером рядка); `scrubKeys(text, keys): {text, leaked: boolean}` (шукає значення цілком і перші 16 символів, міняє на `***`); `callUsd(line, catalog): {usd: number, source: 'cost'|'table'|'unpriced'}`; `totalSpend(lines, catalog): {usd, unpriced: number}` (`call` плюс рядки `{type: 'manual', usd, reason}`); `isScorable(runLine): boolean`.

- [ ] **Крок 1: тести, що падають**

```js
parseKeys('export OPENAI_API_KEY="a"\n\n# c\nANTHROPIC_API_KEY=b\n')  // { OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }
parseRecords('{"type":"call"}\n{"type":"ru')                        // [{ type: 'call' }]
parseRecords('{"ty\n{"type":"call"}\n')                             // throws 'line 1'
scrubKeys('x sk-or-v1-0123456789abcdefXYZ y', { K: 'sk-or-v1-0123456789abcdefXYZ' })  // { text: 'x *** y', leaked: true }
scrubKeys('x sk-or-v1-0123456 y', { K: 'sk-or-v1-0123456789abcdefXYZ' })              // { text: 'x *** y', leaked: true }
scrubKeys('sk-or-v1- y', { K: 'sk-or-v1-0123456789abcdefXYZ' })                       // { text: 'sk-or-v1- y', leaked: false }
```
`callUsd`: `usage.cost: 0.2` дає `{usd: 0.2, source: 'cost'}`, навіть коли є таблиця; `gpt-5.6-sol` із `prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: {cached_tokens: 200, cache_write_tokens: 300}` за формулою спеки `(prompt − cached − write) × input + cached × cachedInput + write × cacheWrite + completion × output` дає точне число з фіксованими цінами тесту; без `cacheWrite` запис за ціною входу; `usage: null` дає `{usd: 0, source: 'unpriced'}`; модель поза каталогом — `unpriced`. `totalSpend` рахує `call` обірваного запуску без рядка `run`, додає `manual` і лічить `unpriced`. `isScorable`: `exit: 0, error: null` — так; `error` непорожній чи `exit: 5` — ні.

- [ ] **Крок 2:** `npx vitest run scripts/eval/lib/records` — падає.

- [ ] **Крок 3:** реалізувати. `callUsd` бере модель із `requestedModel`, а без нього з `model`.

- [ ] **Крок 4:** той самий запуск зелений. Коміт `feat(eval): read records, find leaked keys, count the spend`

### Задача 3: партії, резерв, відбір

**Файли:**
- Створити: `scripts/eval/lib/batches.mjs`, `scripts/eval/lib/batches.test.mjs`, `scripts/eval/lib/selection.mjs`, `scripts/eval/lib/selection.test.mjs`

**Інтерфейси:**
- Використовує: `Catalog`, `priceOf`, `isScorable`.
- Створює в `batches.mjs`: `planBatch({batch, catalog, labels?, verifyModel?, verifyRoute?, judges?, preflight?}): Run[]`, де `Run = {batch, label, draw, pr, head, mode: 'find'|'verify'|'whole', route, findModel, verifyModel, only: {find, verify}, cacheOffModels: string[] | null, from: {label, pr, draw} | null, estimateUsd, expectFailure: boolean}`; `from` називає пошук, чий файл перевіряти: у партії 1 його ще немає на час планування, тому шлях шукає `runBatch` безпосередньо перед запуском. `runKey(run): string`; `savedFindings(lines): Map<string, string>` (ключ `label/pr/draw` на `findingsFile` останнього вдалого пошуку); `nextAction(run, lines): {action: 'skip'} | {action: 'run', attempt: number}`; `admit({spentUsd, estimateUsd, ceilingUsd}): boolean` (`spent + 2 × estimate ≤ ceiling`).
- Створює в `selection.mjs`: `Scores = {<label>: {<draw>: {defects: string[], findings: number}}}`; `isUnstable(draws): boolean`; `survivors(batch, scoresByBatch): string[]`; `checkLabels({batch, labels, scoresByBatch}): string | null` (текст відмови або `null`).

Партії (усередині порядок каталогу, прогони по колу: усі перші, потім усі другі, щоб стеля різала рівномірно):

| № | Запуски |
|---|---|
| 0 | усі кандидати й базлайн, `find` на #895, прогін 1; далі `gpt-5.6-sol` `find` на #688: прогін 1, 2 неявно, прогін 3 із `cacheOffModels: ['gpt-5.6-sol']`; далі `verify` `gpt-5.5` через `openai` на файлі прогону 1 #688 з `cacheOffModels: ['gpt-5.5']`, `expectFailure: true` |
| 1 | базлайн на #418, 3 прогони: `find`, одразу `verify` `gpt-5.5` на його файлі |
| 2 | дешеві, `find` #418, 3 |
| 3 | середні, `find` #418, прогін 1 |
| 4 | `labels` (середні), прогони 2, 3 |
| 5 | дорогі, `find` #418, прогони 1, 2 |
| 6 | `labels` (дорогі), прогін 3 |
| 7 | `labels` (до 5), `verify` `gpt-5.5` через `openai` на кожному їхньому збереженому #418 |
| 101 | базлайн і `labels` (до 2), `whole` на #930, 3 |
| 102 | базлайн, `whole`, корпус за `preflight`, 1 |
| 103 | `labels`, `whole`, корпус за `preflight`, 1 |
| 104 | `judges`, `verify` на збереженому прогоні 1 #418 базлайна і `labels` |
| 105 | базлайн, `whole`, #418 (3) і корпус |
| 106 | `labels`, `whole`, #418, 3 |

Для `whole` не базлайна потрібні `verifyModel`, `verifyRoute`, що збігається з маршрутом мітки, інакше `planBatch` кидає. Оцінка запуску: `find` — розмір із `prs` × ціна; `verify` — 0.19 × відношення ціни виходу судді до `gpt-5.5`; `whole` — сума.

- [ ] **Крок 1: тести, що падають**

`batches.test.mjs`: партія 1 дає точний список `[[find,1],[verify,1],[find,2],[verify,2],[find,3],[verify,3]]`; партія 2 — 30 запусків, перші 10 мають `draw: 1`; партія 0: останні чотири як у таблиці, прогін 3 має `cacheOffModels`, останній `expectFailure: true`; партія 4 без `labels` кидає `labels`; кандидат `openrouter` з `only: null` кидає `--endpoints`, бо незакріплений виконавець робить виміри непорівнянними; партія 102 бере лише PR із `preflight.corpus`; оцінка `find` базлайна на #418 — `0.2576`, `verify` — `0.19`. `admit({spentUsd: 10, estimateUsd: 0.5, ceilingUsd: 11})` — `true`, із `0.51` — `false`. `nextAction`: без рядків — `{action:'run', attempt:1}`; є `run` з `exit: 0, error: null` — `skip`; є лише `exit: 5` — `{action:'run', attempt:2}`; `call` без `run` (обірваний) — `{action:'run', attempt:2}`; `expectFailure` із будь-яким рядком `run` — `skip`.

`selection.test.mjs`: `isUnstable({1:{defects:['D1','D2','D3'],findings:4},2:{defects:['D1'],findings:4}})` — `true`; кількість знахідок 3 і 6 — `true`; 3 і 5 — `false`. `survivors(4, …)` лишає ті, де `defects` ≥ 2 у партії 3; `survivors(6, …)` лишає прогін 1 ≥ 2 і стабільних. `checkLabels`: партія 4 без `scoresByBatch[3]` — текст із `batch 3`; мітка поза тими, хто вижив, — текст із міткою; партія 7 із 6 мітками — текст; партія 2 — `null`.

- [ ] **Крок 2:** `npx vitest run scripts/eval/lib` — падає.

- [ ] **Крок 3:** реалізувати.

- [ ] **Крок 4:** той самий запуск зелений. Коміт `feat(eval): plan the batches, reserve against the ceiling, enforce the selection`

### Задача 4: `funnel.mjs`

**Файли:**
- Створити: `scripts/eval/funnel.mjs`, `scripts/eval/lib/runner.mjs`, `scripts/eval/lib/runner.test.mjs`, `scripts/eval/lib/executors.mjs`, `scripts/eval/lib/executors.test.mjs`

**Інтерфейси:**
- Використовує: усе із задач 1–3.
- Створює в `runner.mjs`: `childArgs(run, paths): string[]`; `childEnv(run, keys, base): Record<string, string>` (із `base` лише `PATH`, `HOME`, `GH_TOKEN`; ключ лише маршруту запуску; `AI_REVIEW_MODEL`, `AI_REVIEW_VERIFY_MODEL`, `AI_REVIEW_OPENROUTER_ONLY`, `AI_REVIEW_VERIFY_OPENROUTER_ONLY`, `AI_REVIEW_CACHE`, `AI_REVIEW_CACHE_OFF_MODELS`, `AI_REVIEW_RECORD_META`); `runBatch({runs, catalog, keys, ceilingUsd, recordsDir, tmpDir, spawnRun, out}): {code, spentUsd, done, failed, left}`; `runPreflight({catalog, spawnRun}): {code, preflight}`.
- `spawnRun(args, env, cwd): Promise<{code, stdout, stderr}>` підставляється в тестах; у `funnel.mjs` — `node:child_process`.
- Створює в `executors.mjs`: `chooseExecutor(modelVendor, endpoints): {tag, price} | null` за правилом спеки: власний хост зі `structured_outputs`; інакше найдешевший зі `structured_outputs`, квантуванням не нижче `fp8`, аптаймом 100 за 30 хв.

Команда: `funnel.mjs --keys <file> --batch <n> --ceiling <usd> [--labels a,b] [--verify-model <id> --verify-route <id>] [--judges m:route,...] [--repo <dir>] [--allow-dirty]`, а також `--preflight`, `--endpoints` (без ключа, друкує `/api/v1/models/<id>/endpoints` і вибір, пише `only` і ціну маршруту `price` у `candidates.json`), `--note-spend <usd> --reason <text>` (рядок `manual`, для `verify-corpus` етапу 2). Шляхи: записи `docs/eval/2026-11/records/batch-<n>.jsonl`, файли знахідок `docs/eval/2026-11/records/findings/b<batch>-<label>-pr<pr>-d<draw>-a<attempt>-<mode>.json`, оцінки `docs/eval/2026-11/scores/batch-<n>.json`, `tmp/eval/<uuid>.jsonl` і `tmp/eval/<uuid>-findings.json`. `--repo` типово `~/projects/warsaw-beer-bot`; брудне дерево — код 2, крім `--allow-dirty`, який потрібен партії 105.

Порядок одного запуску: `admit` → запуск дитини → читання тимчасового запису → `scrubKeys` → дописування кожного рядка зі збагаченням (`requestedModel` — модель етапу, `mode`, `attempt`, `findingsFile`) → перевірка `leaked`, потім копія файла знахідок після такої самої перевірки. Витрати перечитуються зі спільних записів усіх партій. Збій дитини не зупиняє партію; `leaked` зупиняє одразу з кодом 4.

- [ ] **Крок 1: тести, що падають**

`runner.test.mjs` зі стабом `spawnRun`, що пише підготовлені рядки у шлях із `--record`:
```js
it('stops at the ceiling and says what is left', ...)        // ceiling 0.6, два запуски з оцінкою 0.2, перший витратив 0.25: 0.25 + 0.4 > 0.6, другий не йде; code 3, left 1
it('keeps the order of the plan', ...)                        // порядок викликів = порядок runs
it('verifies the file its find just saved', ...)              // find, verify: --verify-from дорівнює findingsFile попереднього запуску
it('does not verify after a failed find', ...)                // find exit 5: verify не викликається, failed 2, code 5
it('counts the calls of a killed child, with a torn last line', ...)  // call, обірваний рядок: call дописаний, spentUsd його має, failed 1
it('skips what is done on a second invocation', ...)          // другий runBatch: spawnRun не викликається
it('reruns a failed run with a new attempt and a new file', ...)  // attempt 2 у шляху знахідок
it('scrubs a leaked key, keeps the spend, stops with 4', ...) // файл без ключа, usage на місці, наступний запуск не пішов
it('passes only the key of the route', ...)                   // openrouter: є OPENROUTER_API_KEY, немає OPENAI_API_KEY і ANTHROPIC_API_KEY; немає NODE_OPTIONS із base
it('refuses a missing key with 2 before any run', ...)
it('returns 5 when a run failed, 0 when an expected failure failed', ...)
```
`childArgs` точним масивом для `find`, `verify`, `whole`. `childEnv` точним об'єктом для пінованого кандидата. `runPreflight`: стаб виводу `Context budget: 1 file(s) sent as diff only: src/a.ts` на #344 — `preflight.corpus` без `344`, причина записана; `a.test.ts` — лишається; те саме на #418 — код 2; менше трьох PR корпусу — код 2; `no reviewable files` — окрема причина, PR випадає; #930 випав — `preflight.recall930: false`.

`executors.test.mjs`: власний хост зі схемою вибирається, хоч і дорожчий; власний без схеми — найдешевший зі схемою; `fp4` чи аптайм 99 відкидаються; нікого — `null`.

- [ ] **Крок 2:** `npx vitest run scripts/eval/lib` — падає.

- [ ] **Крок 3:** реалізувати `runner.mjs`, `executors.mjs`, потім `funnel.mjs` як розбір аргументів над ними. Форму `/endpoints` узяти з живої відповіді, вона без ключа: `curl https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints`.

- [ ] **Крок 4:** `node scripts/eval/funnel.mjs --batch nope` — код 2 і текст використання; `npm run gate` — зелений. Коміт `feat(eval): the funnel runs a batch against the ceiling`

### Задача 5: знеособлення

**Файли:**
- Створити: `scripts/eval/anonymize.mjs`, `scripts/eval/lib/anon.mjs`, `scripts/eval/lib/anon.test.mjs`

**Інтерфейси:**
- Використовує: `parseRecords`, `isScorable`, `SavedFindings` із `src/pr-review/saved-findings.ts` як формат.
- Створює: `anonymize({runs, read, shuffle?}): {items: [{id, pr, head, stage, findings: [...]}], key: {<id>: {label, draw, pr, batch, attempt}}}`; `applyKey(anonScores, key): Scores`. Для `find` знахідки — `kept` файла, для `verify` і `whole` — `results`. Лишаються лише `file`, `line`, `severity`, `confidence`, `quote`, `claim`, `whyItBreaks`, а для перевірки ще `verdict`, `evidence`.

Команда: `anonymize.mjs --batch <n> --out <file> --key <file>` і `anonymize.mjs --apply <anon-scores> --key <file> --batch <n>`, що пише `docs/eval/2026-11/scores/batch-<n>.json`. Ключ типово лежить у `tmp/eval/`, поза тим, що отримує оцінювач.

- [ ] **Крок 1: тести, що падають**

На запусках різних моделей: `JSON.stringify(items)` не містить жодної мітки, id моделі, постачальника, `runId` чи `findModel`; `id` випадкові, порядок задає `shuffle` (підставлений розворот змінює порядок, а `key` лишається вірним); незарахований запуск (`exit: 5`) не потрапляє; `applyKey({<id>: {defects: ['D1'], findings: 3}}, key)` дає `{label: {1: {defects: ['D1'], findings: 3}}}`; `id` поза ключем кидає `Error` із цим `id`.

- [ ] **Крок 2:** `npx vitest run scripts/eval/lib/anon` — падає.

- [ ] **Крок 3:** реалізувати `anon.mjs` і команду. `id` — `randomUUID`.

- [ ] **Крок 4:** той самий запуск зелений. Коміт `feat(eval): anonymize runs for the grader and map the scores back`

### Задача 6: зведення і профілі

**Файли:**
- Створити: `scripts/eval/summary.mjs`, `scripts/eval/lib/summary.mjs`, `scripts/eval/lib/summary.test.mjs`, `scripts/eval/lib/profiles.mjs`, `scripts/eval/lib/profiles.test.mjs`

**Інтерфейси:**
- Використовує: `callUsd`, `isScorable`, `Scores`, `Catalog`.
- Створює в `summary.mjs`: `median(xs)`; `paidUsd(lines, catalog)`; `productionUsd({firstRunUsage, price, cacheRuleApplies}): number` (токени першого прогону × ціна маршруту, без читань; вхід за тарифом запису, якщо модель його має і поріг кешу не спрацював); `summarize({lines, catalog, scores, cacheRuleApplies}): Row[]`, де `Row = {label, route, pair, draws, perDraw, medianKnown, union, medianPublished, refutedMean, errorShare, paidUsd, productionUsd, composite, unstable, corpus: {real, false, unfalsifiable, published}, judgeConsensus, brokenCalls, medianRecall930}`; `anthropicThinking(calls): boolean` (у більшості `completion_tokens ≥ 2 × contentLength / 4`).
- Створює в `profiles.mjs`: `admitted(row): {ok, reasons}`; `pickProfiles(rows, baseline): {best, balanced, value}` — кожна комірка `{row | null, preliminary: boolean, note}`.

Команда: `summary.mjs --batch-from <n> [--cache-rule on|off]` друкує markdown: таблицю конфігів, кандидатів на профіль за трьома таблицями `openai`, `anthropic`, `openrouter`, встановлене поле кешу, перевірку мислення Anthropic, суму записів для звірки з кабінетами.

- [ ] **Крок 1: тести, що падають**

`summary.test.mjs`: `median([1,1,5])` — 1; `productionUsd` для `gpt-5.6-sol` із 1000/100 токенів і `cacheRuleApplies: false` — `1000 × 5/1M + 100 × 20/1M`, а `true` чи модель без запису — за базовим входом; другий прогін не враховується; `summarize`: 1/1/1 з різними дефектами дає `medianKnown: 1`, `union: 3`; запуск із `error` не входить у `perDraw`, але його `call` є в `paidUsd`; `errorShare` — частка вердиктів `error`; суддя лише з `verify-corpus` дає `composite: true`, `verify` на цьому пошуку знімає. `anthropicThinking`: два з трьох викликів вище порога — `true`, один — `false`.

`profiles.test.mjs`, на зібраних рядках: `admitted` відмовляє за `corpus.false: 1`, `published: 2`, менше трьох PR корпусу, `judgeConsensus: 13`, `brokenCalls: 2`; best: більша медіана перемагає, перевага без #930 дає базлайн; за рівності дешевша після медіани #930; balanced: найдешевша в межах одного дефекту на #418 і #930; best value: найдешевша з ≥ 3 на #418 і ≥ 1 на #930, за рівності менше `refuted`; рядок без допуску — `preliminary: true`, а не порожня комірка; нікого на маршруті — `row: null`.

- [ ] **Крок 2:** `npx vitest run scripts/eval/lib` — падає.

- [ ] **Крок 3:** реалізувати. Рядок цін у `productionUsd` — лише з каталогу, не з `usage.cost`.

- [ ] **Крок 4:** `npm run gate` — зелений. Коміт `feat(eval): the summary table and the profile candidates`

## Після плану

Рев'ю всієї гілки, `cross-review` іншою родиною, PR 1. Приймання пісочниці й партія 0 — у WSL власника після злиття.
