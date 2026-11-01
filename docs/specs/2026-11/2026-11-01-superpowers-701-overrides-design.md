# Override-и для Superpowers 7.0.1: оцінка, builder check і решта колізій процесу

Дата: 2026-11-01
Статус: затверджено 2026-11-01
Spec-review: codex/gpt-6.1-sol @ 7a2ae9d (author: claude) — 4 findings: 4 fixed, 0 rejected

## Для власника

**Мета.** Коли в проєкті стоїть і detent, і Superpowers, агент іде процесом detent, а не тим, що
пропонує Superpowers: оцінку першим називає власник, спеку перед власником бачить рецензент
іншої родини, плани ріжуться на ядро й обв'язку, нічого не видаляється командою. Реліз `v0.2.1`.

**Що зміниться для тебе.**
- У першому ж повідомленні brainstorming агент питає твою оцінку XS–XL, а не називає свою.
- Спека приходить до тебе після двох перевірок: «будівельник» (субагент Superpowers, та сама
  родина) і cross-review (інша родина). Зазвичай окремого раунду питань від «будівельника» не
  буде: до трьох питань, які може вирішити лише ти, стоять у «Питаннях до власника» самої
  спеки. Якщо таких питань більше трьох, агент питає тебе **до** cross-review: спека ще не
  готова.
- Після плану агент **не питає** тебе, чи переглянув ти план і яким способом виконувати: обирає
  сам за `detent-pr-slicing` і каже одним рядком. Заперечити можна, чекати — ні.
- Виконання плану без тебе тепер має ще одну зупинку: якщо рішення під час реалізації змінює
  секцію «Для власника» затвердженої спеки, агент зупиняється, бо це поправка, яка повертає
  спеку тобі на затвердження. Поправка лише в тілі спеки виконання не зупиняє.
- Агент більше не робить `rm -rf` робочої теки плану після фінального рев'ю.
- Конституція в CLAUDE.md/AGENTS.md кожного проєкту виросте приблизно на 15 рядків.
- Незворотного нічого: `v0.2.1` ставиться в проєкти окремим кроком.

**На чому стоїть рішення.**
1. Інструкції з CLAUDE.md/AGENTS.md мають пріоритет над скілами, а скіли detent — ні: проти
   скіла Superpowers вони рівноправні. Тому override живе в конституції, скіли лише деталізують.
   `[проба]` (П-1)
2. Сім скілів процесу Superpowers 7.0.1 мають 11 колізій із detent і 3 місця, що лише схожі на
   колізію. `[проба]` (П-2)
3. «Будівельник» і cross-review ловлять різне: перший — де планувальнику довелося б гадати,
   другий — шість перевірок `review-spec.md`, серед яких цього немає. `[проба]` (П-3)
4. Override-и звіряються з релізом Superpowers 7.0.1, а не з конкретною установкою. На цій
   машині він стоїть лише в Codex (Windows і WSL, обидва 7.0.1); у Claude Code його немає, тож
   поведінку в Claude Code ніхто не спостерігав. `[проба]` (П-6)
5. Поведінку override-и називають, назв розділів не згадують. `[вимога власника]`
6. Специ й плани лежать у місячних підтеках, ніколи пласко: за місяць навіть невеликий проєкт
   набирає до сотні задач, і за рік у пласкій теці не знайти нічого. `[вимога власника]`
7. Spike у Superpowers за змістом той самий, що в Scrum/XP і в detent: одноразова робота заради
   знання, результат повертається в розмову, залишити його — новий запит. Розходиться лише в
   одному: Superpowers нічого не каже про коміти. `[проба]` (П-4)

**Ключові рішення.**
1. Override — однорядкова поведінка в п. 7 конституції, процедура — у скілі detent (варіант Б).
   Відкинуто: усе в конституції (кожна сесія кожного проєкту платить за кожен рядок); окремий
   скіл `detent-superpowers` (може бути не завантажений саме тоді, коли діє Superpowers, і не має
   пріоритету над ним, засновок 1).
2. Перед власником: «будівельник» → cross-review → власник. Питання «лише власник» з
   «будівельника» йдуть у «Питання до власника». Відкинуто: лише cross-review (ніхто не перевіряє,
   де план гадатиме); лише «будівельник» (та сама родина, за п. 6 не рецензент).
3. «Малої зміни з короткою спекою» не існує: нижче повної спеки — лише легкий шлях (XS після
   проби). Розміри Superpowers замінюються шкалою XS–XL у тій самій точці.
4. План власнику на затвердження не йде; спосіб виконання агент обирає сам. Відкинуто: лишити
   питання Superpowers (зайвий раунд після затвердженої спеки).
5. Розглянуто стандартне: лишити розміри Superpowers і додати поруч XS–XL — відкинуто, бо дві
   шкали в одному повідомленні й автор однаково називає розмір першим.

**Що стане гірше.**
- Плюс один субагент на кожну спеку (builder check) — токени автора.
- Конституція довша на ~15 рядків у кожному проєкті з detent.
- Без перегляду плану власником помилку плану ловить лише рев'ю ядра.
- Перевірено лише сім скілів процесу; решта восьми Superpowers не звірялися (П-2).

**Оцінка.** Власник: M (можливо L — залежно від знахідок). Автор: S — один PR, план ≤ 4
задачі, нового механізму немає. Розклад: спека з пробами й двома рев'ю ~45%, тексти
override-ів ~35%, тести ~10%, реліз ~10%. Дешевший варіант: закрити лише оцінку, builder check і
`rm -rf`, решту записати як відомі прогалини на 0.2.2 — втрачає умову брифа «кожну знахідку
закрити або пояснити». Розбіжність — один розмір, зупинки немає.

**Питання до власника.** Немає.

## Проби

**П-1. Пріоритет інструкцій.** `skills/using-superpowers/SKILL.md:65` у 7.0.1: «User
instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills,
which in turn override default behavior.» Конституцію detent installer кладе саме в
CLAUDE.md/AGENTS.md; скіли detent — у `.claude/skills/`/`.agents/skills/`, тобто це скіли.

**П-2. Звірка семи скілів.** Прочитано повністю `brainstorming` (з `builder-check-prompt.md`),
`writing-plans`, `subagent-driven-development` (з `references/`), `executing-plans`,
`finishing-a-development-branch`, `using-git-worktrees`, `requesting-code-review` з
`~/.codex/plugins/cache/openai-curated-remote/superpowers/7.0.1/skills/`. Знахідки — таблиця
нижче. Не звірялися: `diagnosing-superpowers`, `dispatching-parallel-agents`,
`receiving-code-review`, `systematic-debugging`, `test-driven-development`,
`verification-before-completion`, `writing-skills`, `using-superpowers` (крім П-1) — бриф їх не
називає, і жоден не визначає порядок «спека → план → PR».

**П-3. Що ловить кожне рев'ю.** `builder-check-prompt.md`: «Report only the questions you'd
still need answered before you could plan this well». `prompts/review-spec.md` detent: перевірки
1–6 — тіло → резюме, засновки, суперечності, заявка → доказ, винахід, дефекти дизайну.
Питання «що планувальнику довелося б вгадати» серед них немає.

**П-4. Що таке spike у Superpowers.** Слово трапляється лише в `brainstorming` (рядки 34, 162–167,
255–256, 272) і непрямо в `test-driven-development:25` («Throwaway prototypes» як виняток з TDD).
Зміст: «A quick throwaway build is often the cheapest way to learn what they want or whether
something works»; spike без тестів чи з мінімальними, пропускає план, реалізацію й рев'ю; «Bring
what the spike taught you back into the conversation»; будувати можна лише після згоди людини;
«keeping what it produced is a new request that comes back through this gate».
Порівняння зі Scrum/XP-spike (дослідження з обмеженим часом, результат — знання, а не
інкремент):
- збігається: одноразовість, мета — знання, результат іде назад у розмову/беклог;
- відрізняється акцентом: у Superpowers це насамперед **збірка** (прототип, який людина може
  клацнути) для з'ясування, **чого вона хоче**, а не лише технічна розвідка; таймбоксу немає;
  потрібна згода людини;
- про коміти не сказано нічого: прототип може опинитися закоміченим на гілці, а звідти
  «продовжити будувати» — один крок.
Spike detent (конституція п. 2: «commits nothing»; проби, виміри, реплей) ширший за видами
робіт, але суворіший щодо комітів. Правило «залишити — новий запит» Superpowers уже має, тож
override потрібен лише на коміти.

**П-5. Робоча тека плану.** `subagent-driven-development/scripts/sdd-workspace` 7.0.1 кладе її в
`<repo-root>/.superpowers/sdd/<plan-basename>/` і створює там самоігнорований `.gitignore` з
`*` (create-only). Тобто тека поза `git status` без жодної правки інсталятора detent; не
видаляти її — безпечно, вона лише накопичує дрібні текстові файли планів.

**П-6. Де стоїть Superpowers.** Пошук у `~/.claude/plugins` (Windows і WSL) і в
`settings.json` Claude Code: Superpowers немає. `~/.codex/plugins/cache/openai-curated-remote/
superpowers/`: `7.0.1` і на Windows, і у WSL.

## Рішення автора після builder check

- **Ціль PR.** `baseBranch` за замовчуванням `origin/main` — це ref для рібейсу. PR відкривається
  на гілку, яку він називає, без імені remote (`main`). Нового ключа в `detent.json` немає.
- **Builder check — лише з Superpowers.** Бриф про колізії із Superpowers; власний промпт
  «будівельника» для шляху без Superpowers — нова можливість, не override. Тому
  `spec-format.md` згадує питання «будівельника» умовно («with Superpowers»), а `detent-dev-cycle`
  не змінюється.

## Колізії

| # | Скіл | Що каже Superpowers | Що каже detent | Рішення |
|---|---|---|---|---|
| K1 | brainstorming | Після вибору підходу автор називає розмір («small change» / «project»); перше повідомлення закінчується одним питанням про те, чого хоче людина | Спершу оцінка власника, своєї не називати; своя — після вибору підходу, з розкладом і дешевшим варіантом; ≥ 2 розміри — стоп | Override: питання в першому повідомленні — оцінка власника XS–XL; питання «чого хочеш» іде наступним повідомленням. Розміри Superpowers → XS–XL (рішення 3) |
| K2 | brainstorming | Builder check субагентом перед власником, окремий раунд питань «theirs» | Cross-review іншою родиною перед власником (п. 6) | Override: builder → cross-review → власник; «theirs» → «Питання до власника»; builder не рецензент за п. 6 |
| K3 | brainstorming | Спека в `docs/superpowers/specs/YYYY-MM-DD-…` | `<specsDir>/<YYYY-MM>/` | Override: шлях detent |
| K4 | brainstorming | Spike, на який погодились, будується без тестів і рев'ю; про коміти нічого (П-4) | Spike нічого не комітить | Override лише на коміти: spike нічого не комітить. «Залишити — новий запит» Superpowers уже каже, не дублюємо |
| K5 | writing-plans | План у `docs/superpowers/plans/YYYY-MM-DD-…` | `plansDir` (а `detent-pr-slicing` без місячної підтеки, хоча плани самого detent лежать у `docs/plans/2026-11/`) | Override і правка `detent-pr-slicing`: `<plansDir>/<YYYY-MM>/` |
| K6 | writing-plans | Після плану просить власника переглянути його й вибрати SDD чи Native | Власник затверджує спеку; про план нічого | Override: не питати; спосіб обрати за `detent-pr-slicing` і назвати одним рядком (рішення 4) |
| K7 | SDD, executing-plans | Після останньої задачі — фінальне рев'ю, потім `finishing` і PR | Ядро → наскрізне рев'ю → план обв'язки → … → PR після останнього плану | Override: фінальне рев'ю плану ядра і є наскрізним рев'ю; далі план обв'язки, `finishing` лише після останнього плану |
| K8 | SDD | BASE береться перед диспатчем імплементера наступної задачі | Інлайн-задача **мусить** увійти в review-пакет наступної | Правка `detent-pr-slicing`: BASE фіксується перед інлайн-задачею й переходить у пакет наступної |
| K9 | SDD, executing-plans | «Rulings, not stalls»: конфлікти вирішує контролер і йде далі; стоп лише на чотири речі | Поправка, що змінює секцію власника, повертає статус «чекає на затвердження» (`spec-format.md` → «Amendments») | Override: таке рішення — п'ята причина зупинки. Поправка лише тіла — ні, як і в `spec-format.md` |
| K10 | SDD, executing-plans | `rm -rf <workspace>` після чистого фінального рев'ю | П. 8: рекурсивне видалення лише скриптом після dry-run | Override: робочу теку не видаляти (вона ігнорується git'ом, П-5), прибирання — за п. 8 |
| K11 | finishing | Питає базову гілку; PR — пуш і відкриття; порядку з рев'ю немає | Рібейс на `baseBranch`, гейт, cross-review, маркер, потім PR | Розширити наявний override: базова гілка з `detent.json`; порядок рібейс → гейт → cross-review → PR |

**Не колізії.**
- `using-git-worktrees`: питає згоду на worktree, якщо в інструкціях немає вподобання. detent
  про worktree нічого не каже — тут немає чому суперечити.
- `requesting-code-review` і фінальне рев'ю SDD: рецензент тієї ж родини. Воно додається до
  cross-review і не заміняє його; п. 6 не забороняє інших рев'ю.
- `finishing` → discard: `git worktree remove` відмовляє на брудному дереві, `git branch -D` — лише
  після набраного `discard`. Це не набрана команда рекурсивного видалення з невідомим шляхом, від
  якої захищає п. 8: шлях — виявлений git'ом worktree, незакомічене не втрачається.

## Тексти override-ів

П. 7 конституції після зміни (англійською, як уся конституція):

```
7. **Superpowers overrides** (apply only when Superpowers is installed). They name behaviour, not
   branch names inside those skills, because branch names change between releases. These
   overrides were checked against Superpowers 7.0.1 (brainstorming, writing-plans,
   subagent-driven-development, executing-plans, finishing-a-development-branch,
   using-git-worktrees, requesting-code-review); on a new Superpowers release, re-read them.
   - `superpowers:brainstorming`:
     - A "quick, clear task — just do it" or "small change — short doc" route does not bypass
       classification. A behaviour change without a spec is possible only on the light path (all
       four conditions, after the probe); everything else gets a full spec per
       `detent-design-spec`. A human opting out of questions cancels the questions, not the spec.
     - Sizing is the estimate game of `detent-design-spec`, not the author naming a size: the
       question that ends your first message is the owner's size (XS–XL), and yours comes only
       after an approach is picked.
     - Before the owner sees a spec: builder check, then `cross-review --spec`. The builder is of
       your family and is not the reviewer of rule 6; its questions only the owner can answer go
       into the spec's questions for the owner, not a separate round. More than three such
       questions means the spec is not ready: ask them in one message before the cross-review.
     - A spike commits nothing. Specs go to `<specsDir>/<YYYY-MM>/`, never flat.
   - `superpowers:writing-plans`: slice the plan per `detent-pr-slicing` and save it under
     `<plansDir>/<YYYY-MM>/`. Do not ask the owner to review the plan or pick an execution method:
     pick it per `detent-pr-slicing` and say which in one line.
   - `superpowers:subagent-driven-development`: do a small task inline (the conditions are in
     `detent-pr-slicing`) instead of dispatching it.
   - `superpowers:subagent-driven-development` and `superpowers:executing-plans`: the final
     review of a core plan is its end-to-end review: write the harness plan next, and finish the
     branch only after the last plan. A ruling that would change the spec's owner section stops
     the run: it is an amendment that returns the spec for approval. Never delete the plan's
     workspace; rule 8 applies.
   - `superpowers:finishing-a-development-branch`: do not ask for the base branch: rebase on
     `baseBranch`, run the gate, run `cross-review`, then open the PR by default, without asking,
     against the branch `baseBranch` names (without the remote). Only a human merges.
```

`detent-design-spec`, порядок робіт:
- крок 1: «With Superpowers, this question ends your first message.»
- новий крок між 5 і 6: «**Builder check** (with Superpowers): run its builder check on the
  written spec. Settle what is already answered or minor yourself; put what only the owner can
  answer into "Questions for the owner". More than three such questions means the spec is not
  ready: ask the owner before the cross-review, in one message.»

`spec-format.md`, поле «Questions for the owner»: «At most three; with Superpowers, these include
the builder check's questions only the owner can answer».

`detent-pr-slicing`:
- «save them under `<plansDir>/<YYYY-MM>/`» замість «under `plansDir`»;
- «Core first» крок 3: «With Superpowers, the final whole-branch review of the core plan is this
  review.»
- «Inline or dispatch»: «Record the base commit before the inline task, so that the next task's
  review package starts from it.»
- «Inline or dispatch»: «With `superpowers:executing-plans` every task is done inline; the
  dispatch rule applies only to `superpowers:subagent-driven-development`.»

Тести `src/content.test.ts` фіксують по одному рядку на кожен override (як наявний тест на
«checked against Superpowers 7.0.1»), список семи скілів у конституції і `<plansDir>/<YYYY-MM>/`
у `detent-pr-slicing`.

Реліз: `package.json` → `0.2.1`, README — посилання `#v0.2.1` і рядок «checked against
Superpowers 7.0.1» з переліком семи скілів, тег `v0.2.1` після мерджу.

## Заявка → доказ

| Заявка | Де записано | Що доводить | Сила |
|---|---|---|---|
| Override-и перевірено проти Superpowers 7.0.1 | п. 7 конституції, README | П-2: повне читання семи названих скілів 7.0.1; заявка звужена до цих семи | сильна для семи, решта не заявляється |
| Override у конституції має пріоритет над скілом Superpowers | п. 7 (неявно, вибір місця) | П-1: рядок 65 `using-superpowers` 7.0.1 | сильна для 7.0.1; на новому релізі перечитати |
| Робочу теку плану можна не видаляти: вона не потрапить у коміт | п. 7 («Never delete the plan's workspace») | П-5: `sdd-workspace` створює самоігнорований `.gitignore` | сильна для 7.0.1 |

## Рев'ю спеки

Перший запуск (Windows) — `Spec-review: failed (author: claude; codex: not installed; agy: output
does not end with a CROSS-REVIEW-RESULT line)`: `codex` є лише у WSL, `agy` у headless-режимі
дістав автовідмову на дозвіл `command`. Повторено з WSL-копії.

| # | Перевірка | Рішення | Причина / що змінено |
|---|---|---|---|
| 1 | 1 (тіло → резюме) | виправлено | Нову зупинку виконання винесено в «Що зміниться для тебе»; звужено до поправки, що змінює секцію власника, — так само, як у `spec-format.md` → «Amendments» (K9, текст override) |
| 2 | 3 (суперечність) | виправлено | Секція власника каже «зазвичай»: понад три питання, які може вирішити лише власник, ідуть одним повідомленням до cross-review |
| 3 | 6 (дефект дизайну) | виправлено | Правило «інлайн або диспатч» обмежено SDD; для `executing-plans` — усе інлайн (override і `detent-pr-slicing`) |
| 4 | 2 (засновки) | виправлено | Засновок 4 перевірено пробою П-6: у Claude Code Superpowers не встановлено; засновок переписано як `[проба]` про реліз, а не установку |
