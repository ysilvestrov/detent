# Install-readiness harness — передумова захищеного store

> Виконання: superpowers:subagent-driven-development. Код пише дешевший субагент; інтегратор проводить перевірку та окреме рев’ю. Цей план починається після наскрізного рев’ю MCP-ядра.

**Мета.** Відокремити фізичний runtime layout від механізму публікації, зберігши чинну поведінку. Після цього окремий поведінковий план зможе додати protected packages і project registration transactions.

**Архітектура.** Наявні `withRuntimeLock(root, action)` і `verifyRuntime(root, contract)` лишаються project-layout адаптерами. Спільні перевірка інвентарю, публікація generation, lock ownership і atomic registry update працюють через внутрішній layout descriptor. Нового install mode, bounded lock recovery або grant writer у refactor немає.

**Стек.** TypeScript, Node >=20, стандартні fs/path/crypto, Vitest; без runtime dependencies.

**Специфікація.** `docs/specs/2026-11/2026-11-09-install-readiness-design.md`, розділ «Встановлений пакет і межа виконання»: «Узагальнення layout та збереження чинної поведінки робляться окремим like-for-like refactor PR, потім protected layout додається поведінковою зміною».

## Загальні обмеження

- MCP-ядро має реальні registration, committed-input, Claude adapter і stdio API. Воно не створює grants і не доводить готовність install.
- Public runtime signatures, disk paths, registry schema, fail-fast lock та помилки не змінюються. `src/runtime/store.test.ts` проходить без редагування.
- Project paths лишаються `.detent/local/runtime.json`, `.detent/install.lock`, `.detent/runtime/<version>/<digest>/<generation>`.
- Немає нових CLI options, конфігурацій, permissions, мережі, моделей або видалення generation.
- Спершу core PR, потім окремий like-for-like refactor PR; поведінкова зміна protected layout спирається на merged refactor. Merge виконує власник.

## Фокус рев’ю

1. Усі старі exports, return values і error behavior лишаються однаковими.
2. Alias/traversal checks виконуються для registry, lock, generation та кожного copied file після виділення коду.
3. Repair публікує нову generation, стара лишається; інша версія/digest не перемикається.
4. Lock не викрадається, чужий змінений lock не видаляється, callback після завершення не може користуватися store.
5. Жодний майбутній protected-layout default не просочується в поточний project adapter.

## Завдання 1. Відокремити layout без зміни поведінки

**Файли.** `src/runtime/store.ts`; за потреби внутрішній `src/runtime/layout.ts`. Чинні `src/runtime/store.test.ts` та `contract.test.ts` незмінні.

**Споживає.** `RuntimeSnapshot`, `RuntimeContract`, `RuntimeRegistry`, `makeContract`, `runtimeKey`, `validateContract`, `parseRegistry` з `contract.ts`.

**Зберігає.** `checkedPath(root, rel):string`, `verifyRuntime(root, contract):string|null`, `withRuntimeLock<T>(root, action:(store:RuntimeStore)=>T):T`, `RuntimeStore.publish(snapshot):{generation:string,reused:boolean}`.

**Внутрішня межа.** Descriptor задає лише relative registry/lock/generation-base paths; усі filesystem operations використовують той самий canonical root і `checkedPath`. Descriptor не приймається від CLI/config/project data і поки має лише project значення. Не додавати generic storage framework чи нову persistent schema.

- [ ] Зафіксувати base commit на окремій refactor-гілці від merged core; перевірити чистий tracked tree.
- [ ] Запустити незмінні runtime-тести, зафіксувати baseline.
- [ ] Виділити descriptor та механізм, лишити project adapters із тими самими paths і signatures. Не змінювати test expectations.
- [ ] Порівняти diff тестів: він порожній. Запустити runtime-тести, typecheck, повний gate і npm smoke.
- [ ] Провести fresh task/whole-change review; виправити підтверджені порушення поведінкової тотожності.
- [ ] Закомітити, rebase на актуальний baseBranch, cross-review іншою родиною, відкрити окремий PR. Не merge автоматично.

## Наступний план після merged refactor

Protected package store і writer transactions отримують власний план на основі виділеного API. Він має включати bounded package/project locks, atomic pending/active inventory та revoke-first disabled state. Далі потрібні native effective config/boundary proof, proposal/apply consent, renderer/installer/doctor та live acceptance. Це ще не реалізовані можливості.

Висновки наскрізного рев’ю MCP-ядра не обходяться в harness: Git без lazy fetch/replacement/прихованих gitlinks, повний budget від початку виклику, responsive cancellation, grounded evidence і standard-text receipt є передумовами core PR. Product installer не може видати `permissionSetupComplete` на підставі лише TOML або scratch proof.
