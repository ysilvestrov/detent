# Велике тестування AI-рев'ю, ядро інструмента: план реалізації

> **Для агентів:** ОБОВ'ЯЗКОВИЙ СКІЛ: superpowers:subagent-driven-development або superpowers:executing-plans. Кроки позначено чекбоксами (`- [ ]`).

**Мета:** `detent pr-review --replay` пише записи кожного оплаченого виклику, показує контекст, закріплює виконавця OpenRouter, вимикає кеш за запитом і запускає пошук окремо від перевірки на збережених знахідках.

**Архітектура:** необов'язковий гачок у `callStructured` бачить кожну відповідь (задача 1). `replay.ts` отримує запис і перевірку контексту (задача 2), запит окремого етапу (задача 3), два окремі кроки (задача 4). `runReview` і шлях CI не змінюються.

**Стек:** TypeScript (ESM, `nodenext`), Node ≥ 20, вбудований `fetch`, vitest.

**Спека:** `docs/specs/2026-11/2026-11-03-pr-review-big-test-design.md`, розділи «Зміни інструмента (PR 1)», «Формат запису», «Приймання».

Це план ядра за `detent-pr-slicing`. `scripts/eval/` (`funnel.mjs`, `summary.mjs`, `anonymize.mjs`, `candidates.json`, `claude-sandbox.json`) — окремий план обв'язки, який пишеться після наскрізного рев'ю ядра. Обидва плани йдуть у PR 1.

## Глобальні обмеження

- Без залежностей під час роботи: `dependencies` у `package.json` не з'являються.
- `runReview`, `review.ts` і запит у CI не змінюються: наявні тести проходять без правок очікувань.
- Нові прапорці й змінні діють лише в `--replay`. Код виходу: 0, 2, 5.
- Жодного рекурсивного чи автоматичного видалення (правило 8 конституції). Тести створюють теки через `mkdtempSync` і не видаляють їх.
- Тести за правилом 5 конституції: точні значення, без умовної логіки, без повтору логіки продукту.
- Запис і файл знахідок не містять ключа API: `error` проходить заміну ключа на `***`.

## На що дивитись на рев'ю

Кожен рядок має тест у названій задачі.

1. Порожня відповідь оплачена, але запуск падає: рядок `call` уже записаний (задача 2).
2. Шлях `--record` у теці, якої ще немає, чи файл, куди не можна писати: тека створюється, а незаписуваний файл дає код 2 ще до першого платного виклику (задача 2).
3. `--verify-from` зі зламаним файлом, іншим PR чи іншим `scope`: код 2 і жодного виклику моделі (задача 4).
4. Ключ у тексті помилки не потрапляє в рядок `run` (задача 2).
5. Порожні змінні `AI_REVIEW_OPENROUTER_ONLY=` (незаданий у shell шаблон) вважаються незаданими, а не `only: [""]` (задача 3).

---

### Задача 1: гачок відповіді

**Файли:**
- Змінити: `src/pr-review/openai.ts`
- Тест: `src/pr-review/openai.test.ts`

**Інтерфейси:**
- Створює: `export interface CallInfo { id: string | null; model: string | null; provider: string | null; finishReason: string | null; contentLength: number; usage: unknown }` і необов'язкове поле `OpenAiDeps.onResponse?: (info: CallInfo) => void`.

- [ ] **Крок 1: тести, що падають**

У `openai.test.ts`, зі стабом відповіді `{id: 'gen-1', model: 'm', provider: 'Moonshot AI', choices: [{finish_reason: 'stop', message: {content: 'abc'}}], usage: {prompt_tokens: 5, prompt_tokens_details: {cache_write_tokens: 3}}}`:

```ts
it('reports every response to onResponse, raw usage included', async () => {
  // ...
  expect(seen).toEqual([{ id: 'gen-1', model: 'm', provider: 'Moonshot AI', finishReason: 'stop', contentLength: 3,
    usage: { prompt_tokens: 5, prompt_tokens_details: { cache_write_tokens: 3 } } }]);
});
it('reports an empty completion before throwing, because it was billed', async () => {
  // content: '' => rejects with NonRetryableError
  expect(seen[0]!.contentLength).toBe(0);
});
it('sends only the standard fields when there is no extraBody', async () => {
  expect(Object.keys(sentBody)).toEqual(['model', 'max_completion_tokens', 'response_format', 'messages']);
});
```

Відсутні в відповіді поля дають `null` (перевірити одним тестом на `{choices:[{message:{content:'a'}}]}`).

- [ ] **Крок 2:** `npx vitest run src/pr-review/openai.test.ts` — падає: `onResponse` не викликається.

- [ ] **Крок 3:** викликати `deps.onResponse` у `request` одразу після `res.json()`, до перевірки `content`. Розширити локальний тип `data`. Викидання з гачка не перехоплювати: збій запису має бути видимим.

- [ ] **Крок 4:** той самий запуск — зелений; `npm run gate` — зелений.

- [ ] **Крок 5: коміт** `feat(pr-review): a hook that sees every model response`

### Задача 2: запис і контекст у `--replay`

**Файли:**
- Створити: `src/pr-review/record.ts`, `src/pr-review/replay-run.test.ts`
- Змінити: `src/pr-review/replay.ts`, `src/pr-review/replay.test.ts`, `src/commands/pr-review.ts` (`USAGE`)

**Інтерфейси:**
- Використовує: `CallInfo` із задачі 1.
- Створює в `record.ts`: `RecordWriter { call(stage: 'find' | 'verify', info: CallInfo): void; run(line: Omit<RunLine, 'type' | 'runId'>): void }`, `openRecord(path: string, runId: string): RecordWriter` (створює теку через `mkdirSync(..., {recursive: true})`, одразу відкриває файл на дописування, щоб збій стався до витрат), типи `CallLine`, `RunLine` з полями спеки «Формат запису».
- Створює в `replay.ts`: `ReplayArgs` із полями `record?: string`, `contextOnly?: boolean`. Прапорець `--context-only` не приймає значення; з ним заборонені `--record`. `AI_REVIEW_RECORD_META` — JSON `{batch, label, draw}`, зливається в рядок `run`; не JSON — код 2.

Спільна обв'язка `replay-run.test.ts`, її використовують і задачі 3–4: `makeRepo()` через `mkdtempSync` і `git -c user.name=t -c user.email=t@t`: коміт `a.ts`, `git update-ref refs/remotes/origin/main HEAD`, другий коміт додає рядок `const x = 1;` і повертає `{cwd, head}`. `gh` — стаб із `JSON.stringify({title:'t', body:'', headRefOid: head, baseRefName:'main'})`. `fetchFn` — стаб, що за `response_format.json_schema.name` (`review_findings` / `review_verdicts`) віддає знахідку з цитатою `const x = 1;` і вердикт `confirmed`, і зберігає тіла запитів. Форма відповідей — за `FINDINGS_SCHEMA` і `VERDICTS_SCHEMA`.

- [ ] **Крок 1: тести, що падають**

У `replay.test.ts`: `resolveReplayArgs(['418', '--record', 'r.jsonl'])` дає `{pr:'418', record:'r.jsonl'}`; `['418','--context-only']` дає `{pr:'418', contextOnly:true}`; `['418','--record']` кидає `--record needs a file path`; `['418','--context-only','--record','r']` кидає `--context-only cannot be combined with --record`.

У `replay-run.test.ts`:
```ts
it('writes one call line per response and one run line, all with one runId', ...)
  // types: ['call', 'call', 'run']; stages ['find','verify']; exit 0; raised 1, gated 1; results[0].verdict 'confirmed'
it('merges AI_REVIEW_RECORD_META into the run line', ...)  // batch 2, label 'x', draw 3
it('keeps the billed call line when the completion is empty, and records exit 5', ...)
  // find returns content '' => runReplay rejects; lines: ['call','run'], run.exit 5, run.error 'OpenAI returned an empty completion'
it('replaces the key in the recorded error', ...)  // HTTP 400 body echoes the key => run.error has '***', file text does not contain the key
it('creates the folder of the record file', ...)  // --record <tmp>/a/b/r.jsonl => file exists
it('returns 2 before any model call when the record file cannot be opened', ...)  // path is an existing directory; fetch bodies: []
it('prints the context budget line', ...)  // out contains 'Context budget: 0 file(s) sent as diff only.'
it('context-only prints the budget and calls no model, with no key at all', ...)  // env {}; code 0; fetch bodies: []
```
Тест імен файлів: контекст із файлом поза бюджетом перевіряти не треба, `buildReviewContext` це вже покриває; рядок для ненульового списку: `Context budget: 2 file(s) sent as diff only: a.test.ts, b.test.ts`.

- [ ] **Крок 2:** `npx vitest run src/pr-review/replay` — падає.

- [ ] **Крок 3:** реалізувати `openRecord` і зміни в `runReplay`:
  - перевірка `AI_REVIEW_RECORD_META` і `openRecord` стоять одразу після вибору моделей, до будь-якого виклику; для `--context-only` вибір постачальника й моделей пропускається;
  - `runId` — `randomUUID()` з `node:crypto`;
  - `onResponse` додається до `transport` окремо на кожен етап лише коли є запис;
  - тіло `runReplay` після відкриття запису обгортається: успіх пише `run` з `exit: 0`, виняток пише `run` з `exit: 5`, `error` із заміною `apiKey` на `***`, і кидається далі;
  - `no reviewable files` теж пише `run` з `exit: 0`, порожніми масивами.

- [ ] **Крок 4:** оновити `USAGE`; `npm run gate` — зелений, наявні тести без правок очікувань, крім тексту `USAGE`, якщо його хтось закріплює.

- [ ] **Крок 5: коміт** `feat(pr-review): replay records every paid call and shows its context`

### Задача 3: закріплення виконавця і кеш за етапами

**Файли:**
- Змінити: `src/pr-review/replay.ts`, `src/pr-review/replay-run.test.ts`, `src/pr-review/replay.test.ts`

**Інтерфейси:**
- Створює в `replay.ts`: `export function stageExtraBody(p: { provider: Provider; model: string; only: string | undefined; cacheOff: boolean; cacheOffModels: string | undefined }): Record<string, unknown> | undefined`, де `only` — сирий вміст `AI_REVIEW_OPENROUTER_ONLY` чи `AI_REVIEW_VERIFY_OPENROUTER_ONLY`, `cacheOff` — `AI_REVIEW_CACHE === 'off'`.

- [ ] **Крок 1: тести, що падають**

У `replay.test.ts`, на `PROVIDERS`:
```ts
expect(stageExtraBody({ provider: PROVIDERS.openrouter, model: 'm', only: 'openai,azure', cacheOff: false, cacheOffModels: undefined }))
  .toEqual({ provider: { only: ['openai', 'azure'], allow_fallbacks: false, require_parameters: true } });
expect(stageExtraBody({ provider: PROVIDERS.openrouter, model: 'm', only: ' ', cacheOff: false, cacheOffModels: undefined }))
  .toEqual({ provider: { require_parameters: true } });
expect(stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.6-sol', only: undefined, cacheOff: true, cacheOffModels: 'gpt-5.6-sol, gpt-6.1-sol' }))
  .toEqual({ prompt_cache_options: { mode: 'explicit' } });
expect(stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.5', only: undefined, cacheOff: true, cacheOffModels: 'gpt-5.6-sol' }))
  .toBeUndefined();
expect(stageExtraBody({ provider: PROVIDERS.openai, model: 'gpt-5.6-sol', only: undefined, cacheOff: true, cacheOffModels: undefined }))
  .toBeUndefined();
```

У `replay-run.test.ts`:
```ts
it('pins each stage to its own executor', ...)  // openrouter key; ONLY=moonshotai, VERIFY_ONLY=openai
  // find body provider.only ['moonshotai'], verify body provider.only ['openai']
it('refuses a pin outside openrouter with code 2 and no model call', ...)  // openai key, ONLY=x; err contains 'AI_REVIEW_OPENROUTER_ONLY'
it('leaves the body alone without these variables', ...)  // openai: keys of the find body are the four standard ones
```

- [ ] **Крок 2:** `npx vitest run src/pr-review/replay` — падає.

- [ ] **Крок 3:** реалізувати `stageExtraBody` і застосувати окремо для етапів `find` і `verify` у `runReplay`. Порожній `only` вважається незаданим. Перевірка закріплення поза OpenRouter стоїть там само, де вибір моделей.

- [ ] **Крок 4:** `npm run gate` — зелений.

- [ ] **Крок 5: коміт** `feat(pr-review): replay pins the OpenRouter executor and turns cache writes off per stage`

### Задача 4: пошук окремо від перевірки

**Файли:**
- Створити: `src/pr-review/saved-findings.ts`, `src/pr-review/saved-findings.test.ts`
- Змінити: `src/pr-review/replay.ts`, `src/pr-review/replay-run.test.ts`, `src/pr-review/replay.test.ts`, `src/commands/pr-review.ts` (`USAGE`)

**Інтерфейси:**
- Створює в `saved-findings.ts`: `export interface SavedFindings { v: 1; pr: string; head: string; base: string; findModel: string; scope: string; raised: RawFinding[]; kept: GatedFinding[]; dropped: DroppedFinding[] }`, `saveFindings(path: string, s: SavedFindings): void`, `readFindings(path: string): SavedFindings` (кидає `Error` із назвою поля на зламаному файлі; перевірки власноруч, як `validate.ts`).
- `ReplayArgs` отримує `findOnly?: boolean`, `saveFindings?: string`, `verifyFrom?: string`.

- [ ] **Крок 1: тести, що падають**

У `replay.test.ts`: `--find-only` без `--save-findings` кидає `--find-only needs --save-findings`; `--save-findings` без `--find-only` кидає те саме; `--verify-from f` разом із `--find-only`, `--head` чи `--base` кидає `--verify-from takes the head and the base from its file`.

У `saved-findings.test.ts`: збережене читається без втрат (`toEqual`); `{v: 2}` кидає `v`; без `kept` кидає `kept`; елемент `kept` без `matchedLine` кидає `matchedLine`.

У `replay-run.test.ts`:
```ts
it('find-only makes one call and saves what passed the gate', ...)
  // bodies: only review_findings; file: kept[0].matchedLine 3 (line of the added code), head, pr '418', scope === settings.scope
it('find-only works for a provider with no default verify model', ...)  // anthropic key, AI_REVIEW_MODEL only: code 0
it('verify-from sends the same verify request as a whole run', ...)
  // body of review_verdicts in a whole run toEqual the one from find-only + verify-from, with the same model
it('verify-from counts on another provider than the find', ...)  // saved by openrouter run, verified with --provider openai: code 0, request to api.openai.com
it('verify-from refuses another PR with code 2 and no model call', ...)
it('verify-from refuses another scope with code 2 and no model call', ...)  // changed .detent/prompts/pr-review-verify.md in the worktree
it('verify-from refuses a broken file with code 2 and no model call', ...)
it('verify-from records verify calls and a run line with raised and gated from the file', ...)
```

- [ ] **Крок 2:** `npx vitest run src/pr-review` — падає.

- [ ] **Крок 3:** реалізувати:
  - після `applyGate` `--find-only` зберігає файл, друкує `raised N → gated M`, зниклі знахідки, рядок витрат і завершується кодом 0;
  - перевірку й друк із `runReplay` винести у внутрішню функцію, спільну для обох шляхів;
  - `--verify-from` читає файл до вибору постачальника: помилка читання, інший `pr` чи `scope` — код 2. Голова береться з файла; вона має бути в клоні через `ensureHeadCommit`, але `gh` не викликається, тому `fetchHead` для цього шляху — `git fetch origin <head>`;
  - `resolveModels` у `--find-only` отримує `verifyModel` рівний моделі пошуку, у `--verify-from` `findModel` рівний `saved.findModel`: потрібна лише одна модель, а постачальник може не мати типових;
  - ID запитів перевірки такі самі, як у звичайному запуску (`f<i>`).

- [ ] **Крок 4:** оновити `USAGE`; `npm run gate` — зелений.

- [ ] **Крок 5: коміт** `feat(pr-review): replay runs find and verify as separate steps`

## Після плану

Наскрізне рев'ю ядра, потім план обв'язки. Живого виклику в цьому плані немає: партія 0 перевіряє поля постачальників (`cache_write_tokens`, `usage.cost`, `provider`) і `prompt_cache_options`.
