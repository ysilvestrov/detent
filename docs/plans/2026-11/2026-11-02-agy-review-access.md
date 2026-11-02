# План: рецензент `agy` — доступ до diff і відмова без звіту

Спека: [2026-11-02-agy-review-access-design.md](../../specs/2026-11/2026-11-02-agy-review-access-design.md).
Виконання: `inline`, бо обидві задачі малі (повний код є у спеці, до двох файлів плюс тести, нових
рішень немає). Один PR, рефакторингу окремо немає.

## Задача 1. Адаптер

Файли: `src/review/adapters.ts`, `src/review/adapters.test.ts`.

1. Тести спершу: точні `args` команди рев'ю (`--add-dir` одразу перед `-p`, преамбула одним рядком,
   потім `\n\n`, шлях snapshot через `join`) і канарки (`--add-dir`, без преамбули). Переконатися, що
   падають.
2. `agyArgs` отримує `runDir`; `command` дописує преамбулу зі шляхом
   `runArtifacts(p.runDir).snapshot`.
3. Гейт, коміт.

## Задача 2. Закріплення відмови і README

Файли: `src/review/cli-runner.test.ts`, `README.md`.

1. Тест: exit 0, порожній stdout, `jetski…"read_file" permission` дає збій
   `output does not end with a CROSS-REVIEW-RESULT line`.
2. README: рядок `agy` у таблиці команд; абзац про `--add-dir`, преамбулу, shell (включно з
   глобальним allow) і можливий збій без звіту.
3. Гейт, коміт.

## Перед PR

Живі прогони `node dist/cli.js cross-review --author claude --reviewer agy` в обох режимах, потім
cross-review гілки за скілом `detent-cross-review`. Версія в цей PR не входить.
