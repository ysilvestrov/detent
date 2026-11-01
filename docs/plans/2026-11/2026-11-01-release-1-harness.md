# План обв'язки релізу 1: скіли, конституція, `detent install`, плагін

Дата: 2026-11-01
Спека: [docs/specs/2026-11/2026-11-01-release-1-design.md](../../specs/2026-11/2026-11-01-release-1-design.md)
(затверджено; поправки власника від 2026-11-01, зокрема П-Е та «файл без запису в маніфесті» й
«Superpowers окремо для кожної цілі»)
Спирається на: [наскрізне рев'ю ядра](2026-11-01-release-1-core-review.md) (висновки 2–6, 10).
Ядро: PR #1, змерджено (`958b994`), тег `v0.1.0`.

## Розріз на PR

Спека оцінює всю зміну як L, 3 PR; ядро вже стало першим. Обв'язка — ще два:

- **PR 2** (`feat/release-1-harness`): задачі 1–4 — скіли, конституція, `detent install`.
  Це механізм, на якому стоїть решта.
- **PR 3** (окрема гілка від `main` після мерджу PR 2): задачі 5–6 — плагін Claude, README з
  установкою, `examples/`, живі проби «скіл підхоплюється агентом». Плагін читає ту саму теку
  `skills/` (рішення 1), тож має сенс лише після PR 2.

## Рішення, взяті зі спеки й рев'ю ядра (щоб виконавець не вирішував сам)

- **Корінь проєкту** для `install` — `git rev-parse --show-toplevel`, як і в `cross-review`:
  `detent.json`, який пише інсталятор, мусить читати саме той CLI. Не git-репо — exit 2.
- **Коди виходу `install`**: 0 — ок (зокрема `--dry-run`), 2 — використання, 4 — конфлікт
  (змінений файл, обірвана пара маркерів). Спершу перевіряється все, потім пишеться.
  Exit 4 — нічого не записано, навіть `detent.json` і `.gitignore`.
- **Рядок про автора в `detent-cross-review`.** Джерело `skills/cross-review/SKILL.md` містить
  варіант для Claude між маркерами `<!-- detent:author begin -->` і `<!-- detent:author end -->`:
  плагін Claude читає `skills/` як є, тож без підстановки там мусить стояти правильний для
  Claude текст. Для `.agents/` інсталятор замінює вміст між маркерами на інструкцію зі спеки
  (`codex` або `agy` залежно від того, хто запущений; `agy` на Claude-моделі передає
  `--author claude`). Хеш у маніфесті — від записаного (уже підставленого) вмісту.
- **Конституція посилається на ключі `detent.json` за назвою** (`specFile`, `specsDir`, …), а не
  підставляє значення. Тоді блок однаковий в усіх проєктах (окрім рядка `dev-cycle`), а зміна
  `detent.json` не вимагає перевстановлення. Рядок `dev-cycle` — останній рядок усередині блоку.
- **Хеш і закінчення рядків.** Інсталятор пише файли з LF, а sha256 рахує від вмісту з `\r\n` →
  `\n`. Причина: проєкт комітить `.claude/skills/` і `CLAUDE.md`, і `core.autocrlf=true` на
  Windows перепише їх у CRLF при checkout. Хеш «сирих байтів» дав би хибний exit 4 на першому ж
  оновленні. Спека хоче ловити ручні правки, а конвертація закінчень рядків правкою не є.
  Рішення назване власнику в підсумку цього плану.
- **Маніфест** `.detent/manifest.json`:
  `{ "detentVersion": "0.1.0", "files": { "<шлях від кореня, />": { "sha256", "version" } }, "blocks": { "CLAUDE.md": { "sha256", "version" }, "AGENTS.md": {…} } }`.
  Маніфест сам себе не хешує. Записується останнім.
- **Вихід скіла `cross-review`** (рев'ю ядра, висновок 4): скіл бере рядок stdout після
  `PR marker: ` або `Spec marker: `. Exit 5 — маркер `failed (…)` усе одно друкується, а скіл
  велить назвати збій людині в повідомленні.
- **Роутер** (рев'ю ядра, висновок 5): `install` додається в `src/cli.ts` і в `USAGE`.

## Задачі PR 2

Оцінка розміру — до диспатчу, за `detent-pr-slicing`.

### Задача 1. Конституція й скіл `detent-design-spec` — **диспатч** (> 2 файлів, тексту в плані немає)

Файли: `constitution/constitution.md`, `skills/design-spec/SKILL.md`,
`skills/design-spec/spec-format.md`, `src/content.test.ts`.

- `constitution.md` — лише тіло блоку, без маркерів: маркери додає інсталятор. Англійською,
  вісім пунктів зі спеки («Шаблон конституції»), з посиланнями на ключі `detent.json`. Пункт 7
  несе рядок `checked against Superpowers 7.0.1`, override формулюють **поведінку**. Немає
  `deploy:hold`, міграцій, бюджету, чейнджлогу, сиріт. Рядок `dev-cycle` сюди не входить: його
  додає інсталятор.
- `spec-format.md` — порт `C:\Projects\warsaw-beer-bot\docs\spec-format.md` (лише читати),
  англійською. Очищено від warsaw: шкала з L = «2–3 PR або крок, який виконує людина поза репо»;
  «Мета» — «що зміниться для користувача продукту або для ресурсів проєкту». Мітки засновків
  (`[вимога власника]`, `[проба]`, `[виведення]`) і назви секцій пишуться мовою з
  `language` у `detent.json` — скіл каже це явно.
- `SKILL.md` — frontmatter `name: detent-design-spec`, description з точкою процесу
  («Use when writing a design spec…»); тіло — порядок роботи: гра в оцінку, проби, таблиця
  «заявка → доказ», `cross-review --spec`, `Spec-review:` у заголовку; формат — у
  `spec-format.md` поруч.
- `src/content.test.ts` (росте в задачі 2): для кожного `skills/*/SKILL.md` — frontmatter
  з `name`, що дорівнює `detent-<тека>` і проходить `^[a-z0-9-]+$`, і непорожнім `description`.
  У `skills/`, `constitution/`, `prompts/` немає `warsaw`, `beer`, `deploy:hold`, `orphan`,
  `SQLite`. У конституції є `checked against Superpowers 7.0.1` і немає `bounded`.

### Задача 2. Скіли `detent-pr-slicing`, `detent-cross-review`, `detent-dev-cycle` — **диспатч** (3 файли без тексту в плані)

Файли: `skills/pr-slicing/SKILL.md`, `skills/cross-review/SKILL.md`,
`skills/dev-cycle/SKILL.md`, доповнення `src/content.test.ts`.

- Зміст — розділ спеки «Скіли» дослівно за змістом, англійською.
- `cross-review`: запуск **у фоні**, 15 хв; `--author`, без `--reviewer`; протокол розбору
  (виправити або відхилити з причиною, ніколи наосліп); один раз на PR чи спеку; docs-only —
  `skipped (docs-only)`; маркер — рядок після `PR marker: ` / `Spec marker: `; exit 5 —
  сказати людині прямо; блок автора між маркерами (варіант Claude:
  `You are Claude: pass --author claude.`).
- `dev-cycle`: description рівно `Only when invoked explicitly.`; перший крок перевіряє
  Superpowers і передає керування `superpowers:brainstorming`, якщо він є.
- Тести: description `dev-cycle` дорівнює `Only when invoked explicitly.`; у
  `cross-review/SKILL.md` рівно одна пара маркерів автора, між ними — `--author claude`;
  `cross-review` не згадує `--reviewer` як те, що скіл передає.

### Задача 3. Інсталятор: чиста логіка — **диспатч** (> 2 файлів, нові модулі)

Файли: `src/install/args.ts`, `src/install/blocks.ts`, `src/install/manifest.ts`,
`src/install/plan.ts`, `src/install/superpowers.ts` і їхні `*.test.ts`. Без fs і процесів:
усе, що читається з диска, передається аргументами.

- `args.ts`: `--claude`, `--agents`, `--dry-run`, `--superpowers yes|no`; без цілей — обидві;
  невідомий прапорець чи значення — помилка.
- `blocks.ts`: маркери з версією (`<!-- detent:constitution v1 begin — … -->` / `<!-- detent:constitution end -->`,
  текст рядка — зі спеки); `findBlock(text)` → немає / одна пара / обірвана (лише begin чи лише
  end, кілька пар) — тоді exit 4; `replaceBlock`, `appendBlock` (порожній рядок перед блоком,
  якщо файл не закінчується ним); заміна автора між `detent:author`-маркерами.
- `manifest.ts`: `parseManifest` (немає файла → порожній; битий → помилка, exit 2),
  `hashContent` (LF-нормалізація, sha256 через `node:crypto`), `serializeManifest`.
- `superpowers.ts`: `detectSuperpowers({ projectClaudeSettings, userClaudeSettings, codexCacheDirs, agentsSkillNames })`
  → `{ claude: { found, where }, agents: { found, where } }` за поправкою власника;
  `superpowers@…: true` лише в `enabledPlugins`; битий JSON settings — «не знайдено» з причиною
  в `where` (не помилка). Також `detentPluginEnabled(settings)` для попередження про дублікати.
- `plan.ts`: `planInstall({ targets, sources, existing, manifest, superpowers, gitignore, detentJson, version })`
  → `{ ok: true; actions; notes } | { ok: false; conflicts }`. Дія — `create | update | adopt | unchanged`
  для кожного файла скіла й кожного блоку, плюс `detent.json` (створити, якщо нема),
  `.gitignore` (дописати `tmpDir`, якщо рядка немає; `tmpDir` — з наявного `detent.json` або
  дефолт), маніфест. Правила спеки: збіг хеша з маніфестом → update; немає в маніфесті й вміст
  той самий → adopt; інакше конфлікт. Застарілі скіли (у маніфесті є, у джерелі немає) → лише
  нотатка «stale, delete with a script if not needed», без дії.
- Тести на кожне правило, разом із межами: порожній проєкт, повторна установка без змін (усе
  `unchanged`), CRLF-копія того самого вмісту → `unchanged`, змінений скіл → конфлікт і нуль дій,
  обірвана пара маркерів, блок без маркерів → append, `--superpowers no` перекриває знахідку,
  `.gitignore` без кінцевого переводу рядка.

### Задача 4. Інсталятор: I/O, команда, роутер — **диспатч** (I/O, кілька файлів)

Файли: `src/commands/install.ts`, `src/commands/install.test.ts`, `src/cli.ts`.

- `install(argv, { cwd, env, home, out, err }) → exit code`. Корінь — git toplevel. Читає
  джерела з пакета (`skills/`, `constitution/` від `import.meta.url`), стан проєкту й `home`
  (`~/.claude/settings.json`, `~/.codex/plugins/cache/*/`), будує план, на `--dry-run` друкує
  його й виходить 0, інакше пише (LF, `mkdir -p` для тек), маніфест останнім. Друкує по цілі,
  чи знайдено Superpowers і де, і чи додано рядок `dev-cycle`. Попереджає про ввімкнений
  плагін detent у `.claude/settings.json`. Нічого не видаляє.
- `src/cli.ts`: команда `install`, рядок у `USAGE`.
- Наскрізні тести в тимчасовому git-репо з тимчасовим `home`: перша установка (дерево файлів,
  маніфест, блоки, `.gitignore`, `detent.json`); повтор — нуль змін; правка скіла руками →
  exit 4 і жоден файл не змінився (порівняти вміст до/після); `--dry-run` нічого не пише;
  `--claude` пише лише в `.claude/` і `CLAUDE.md`; Superpowers у `home` → без рядка `dev-cycle`
  для відповідної цілі; текст `CLAUDE.md` поза маркерами лишається байт у байт.

## Задачі PR 3

### Задача 5. Плагін Claude — **розмір оцінити перед диспатчем**

Файли: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, тест на їхню форму.
Формат — за поточною документацією Claude Code (перевірити на момент задачі). Скіли — з `skills/`.

### Задача 6. README, `examples/`, живі проби — **розмір оцінити перед диспатчем**

- README: установка з git (`npm i -D github:ysilvestrov/detent#v<версія>`, `npx detent install`),
  `detent.json`, `cross-review`, Windows-шими npm (рев'ю ядра, висновок 6), прибирання тек
  запусків скриптом (висновок 2), рядки «заявка → доказ» про підхоплення скілів.
- `examples/warsaw-beer-bot.detent.json` — значення з warsaw (лише читати): шляхи
  `docs/superpowers/…`, `reviewContext` з обмеженнями проєкту.
- Живі проби: `npx detent install` у чистий проєкт на Windows і в WSL; Codex і `agy`
  бачать `detent-*` скіли з `.agents/skills/` (як П-В2, П-А2).

## Гейт і рев'ю

`npm run gate` після кожної задачі на Windows; перед кожним PR — `git fetch`, rebase на
`origin/main`, гейт у WSL, `detent cross-review --author claude` зібраним CLI у фоні,
маркер в описі PR.
