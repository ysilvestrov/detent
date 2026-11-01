# Override-и для Superpowers 7.0.1 — план

**Спека:** `docs/specs/2026-11/2026-11-01-superpowers-701-overrides-design.md` (затверджено
2026-11-01). Тексти override-ів — дослівно з розділу «Тексти override-ів».

Чотири задачі, кожна дрібна (повний текст у спеці, ≤ 2 файли плюс тести, без нових рішень) — усі
інлайн, кожна з повним гейтом (`npm run gate`) і власним комітом. Наскрізне рев'ю — cross-review
PR.

### Задача 1: п. 7 конституції

**Files:** `constitution/constitution.md`, `src/content.test.ts`

- Замінити п. 7 текстом зі спеки.
- Тести в `describe('constitution')`: перелік семи скілів у рядку «checked against»; по одному
  `includes(...)` на кожен новий override: оцінка (`the question that ends your first message is
  the owner's size`), builder check (`builder check, then \`cross-review --spec\``), spike
  (`A spike commits nothing.`), підтеки (`` `<specsDir>/<YYYY-MM>/`, never flat ``), план без
  питання (`Do not ask the owner to review the plan`), ядро (`the final\n     review of a core
  plan is its end-to-end review` — перевіряти без переносу рядка, нормалізувавши пробіли),
  зупинка (`stops\n     the run`), робоча тека (`Never delete the plan's`), finishing (`do not ask
  for the base branch`).

### Задача 2: `detent-design-spec`

**Files:** `skills/design-spec/SKILL.md`, `skills/design-spec/spec-format.md`,
`src/content.test.ts`

- `SKILL.md`: доповнення кроку 1 і новий крок «Builder check» між 5 і 6 (кроки
  перенумеруються: 6 → 7 … 8 → 9).
- `spec-format.md`: поле «Questions for the owner».
- Тести: по одному `includes(...)` на кожне доповнення; кроків у `design-spec` — 9.

### Задача 3: `detent-pr-slicing`

**Files:** `skills/pr-slicing/SKILL.md`, `src/content.test.ts`

- `<plansDir>/<YYYY-MM>/`; доповнення кроку 3 «Core first»; два речення в «Inline or dispatch».
- Тести: по одному `includes(...)` на кожне доповнення.

### Задача 4: реліз 0.2.1

**Files:** `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `README.md`

- Версія `0.2.1`: `npm version 0.2.1 --no-git-tag-version` (генерує `package.json` і
  `package-lock.json`), руками — `plugin.json`. Ручних правок два файли плюс згенерований lock;
  `src/plugin.test.ts` звіряє версії plugin.json і package.json.
- README: заголовок «Release 1 (v0.2.1)», посилання `#v0.2.1`, у переліку конституції — «checked
  against Superpowers 7.0.1: brainstorming, writing-plans, subagent-driven-development,
  executing-plans, finishing-a-development-branch, using-git-worktrees, requesting-code-review».
- Тег `v0.2.1` — після мерджу PR, на коміті мерджу.
