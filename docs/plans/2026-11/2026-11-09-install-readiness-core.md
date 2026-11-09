# Ядро встановлення Detent — план реалізації

> Виконання: `superpowers:executing-plans`, послідовно в цій сесії; окреме рев'ю всього ядра після завершення. Реалізація периферії планується після цього рев'ю.

**Мета:** самодостатня локальна копія CLI, перевірений launcher та незалежні runtime різних worktrees.
**Архітектура:** контракт version/digest/files; реєстр generation за парою version/digest; публікація під lock з атомарною заміною реєстру; launcher перевіряє копію до import. Інсталятор, delivery скілів і дозволи — наступний план.
**Стек:** TypeScript, Node >=20, node:fs/crypto/child_process; Vitest; без runtime-залежностей.
**Специфікація:** `docs/specs/2026-11/2026-11-09-install-readiness-design.md`, база `78cfc3f`, власник дозволив почати реалізацію 2026-11-09.

## Загальні обмеження

- Claude та Antigravity зберігають чинний npx-шлях; core його не змінює.
- Runtime не завантажує пакети, не змінює політику хоста, не видаляє старі generation.
- Версія/digest, інвентар, шляхи та реєстр перевіряються до виконання; symlink-escape заборонено.
- Common-dir не визначає корінь checkout; sharing тільки для окремо перевіреного звичайного main checkout.
- Налаштування доступу Codex не реалізуються на основі непідтвердженої діагностики; це compatibility gate наступного плану.

## Фокус рев'ю

1. Пошкоджений локальний запис не маскується fallback у main checkout — тест завдання 2.
2. Оновлення main v1 → v2 не ламає linked worktree v1 — тест завдання 3.
3. Зміна copied JS виявляється перед його виконанням — subprocess тест завдання 3.
4. Небезпечні version/generation/inventory paths не виходять за runtime root — тести завдань 1–2.
5. Separate-git-dir/bare layout не виводить шлях із parent(metadata) — тести завдання 3.

## Завдання 1: Контракт і реєстр

Файли: `src/runtime/contract.ts`, `src/runtime/contract.test.ts`.
Інтерфейси: `RuntimeContract {version:string; digest:string; files:Record<string,string>}`;
`RuntimeSnapshot {contract:RuntimeContract; contents:Record<string,Buffer>}`;
`snapshotPackage(source:string):RuntimeSnapshot`; `parseRegistry(text:string):RuntimeRegistry`;
`RuntimeRegistry {schemaVersion:1; entries:Record<string,{generation:string}>}`.

- [x] RED: реальний package fixture дає byte hashes, відкидає symlink, залежності, traversal, некоректний registry; обидві пари v1/v2 збережені.
- [x] GREEN: детермінований інвентар package.json + dist/prompts/skills/constitution; строгі codecs; source metadata не є доказом publisher trust.
- [x] Перевірити `npm test -- src/runtime/contract.test.ts`, потім `npm run gate`; коміт.

## Завдання 2: Store і publication

Файли: `src/runtime/store.ts`, `src/runtime/store.test.ts`.
Споживає контракт завдання 1. Виробляє `withRuntimeLock<T>(root:string, action:(store:RuntimeStore)=>T):T`;
`RuntimeStore.publish(snapshot:RuntimeSnapshot):{generation:string; reused:boolean}`;
`verifyRuntime(root:string, contract:RuntimeContract):string|null` (шлях generation або відсутня пара; corrupt кидає помилку).

- [x] RED: publish/read/repeat, repair новою generation, v1/v2 та два digest однієї версії, зайнятий lock, пошкоджений registry, path aliases.
- [x] GREEN: exclusive lock з owner PID, перевірка шляхів, generation uuid, перевірка записаної копії; повний реєстр через temp+rename у тому самому каталозі; finally знімає лише власний lock.
- [x] Перевірити `npm test -- src/runtime/contract.test.ts src/runtime/store.test.ts`, `npm run gate`; коміт.

## Завдання 3: Переносимий launcher і worktree discovery

Файли: `src/runtime/launcher.ts`, `src/runtime/launcher.test.ts`.
Споживає контракт та layout store. Виробляє `renderLauncher(contract:RuntimeContract):string` — самодостатній `.mjs` з вбудованим очікуваним інвентарем.

- [ ] RED: реально виконати згенерований launcher через Node: локальний runtime, mismatch version, tamper до import, пробіли/Unicode, moved project, linked worktree v1 при main v2, separate-git-dir та bare без помилкового sharing.
- [ ] GREEN: локальна пара має пріоритет; corrupt відмова; лише absent дозволяє validated main fallback; не chdir до runtime; жодного npm/npx або source import до перевірки.
- [ ] Перевірити `npm test -- src/runtime`, `npm run gate`; коміт.

## Завдання 4: Рев'ю ядра і наступний план

- [ ] Свіжий reviewer читає spec, цей план і весь core diff; виправити важливі findings із RED→GREEN, виконати повний gate.
- [ ] Записати рішення та перевірки в журнал нижче. Лише потім планувати installer/skill/doctor інтеграцію від фактичних API.
- [ ] Для Codex permission adapters спочатку перевірити документований механізм активного хоста; за відсутності потрібного доказу повернути власнику конкретне обмеження, не будувати фальшиве підтвердження.

## Журнал

База: `78cfc3f`. Worktree: `install-readiness`, гілка `codex/install-readiness`.
Ruling: ядро можна реалізувати незалежно від непідтверджених адаптерів дозволів; повний setup/готовність не заявляються до їх окремого вирішення.

Завдання 1: контракт та реєстр реалізовано; RED — відсутній `contract.js`; GREEN — 20/20 нових тестів. `npm run gate`: 1518 passed, 1 skipped; typecheck/build passed.

Завдання 2: filesystem store реалізовано; RED — відсутній `store.js`; GREEN — 27/27 runtime tests. `npm run gate`: 1525 passed, 1 skipped; typecheck/build passed.

Проміжне fresh review завдань 1–2: Important/Critical findings відсутні, reviewer повторив 27/27 runtime tests.
Final: minor (deferred): generic `withRuntimeLock` допускає async callback на рівні типів, але lock синхронний; поточні виклики лише синхронні. До інтеграції async-підтверджень контракт треба явно обмежити або змінити API.
Ruling: після повторного cross-review та вибору власника готувати поправку про довірений launcher поза writable-проєктом; завдання 3 проєктного launcher не починати до її затвердження. Ціна: інтеграція затримана, але не закріплює відому суперечність постійних дозволів.
