# Проба проєктного MCP cross-review

Дата 2026-11-09. План `docs/plans/2026-11/2026-11-09-cross-review-mcp-probe.md`.

## Поточний висновок

Основний механізм підтверджено в Codex CLI та Desktop на перевіреному Windows-середовищі. Після однієї явної згоди власника на синтетичний A та його worktree модель `gpt-6-luna` викликала один і той самий MCP-інструмент у нових CLI-сесіях. Реальні CLI spec/code рев'ю виконала `claude-haiku-5-5`. Власник потім успішно повторив spec/code MCP-виклики в окремих Desktop-чатах A та A-linked. Додаткових запитів дозволу не було за прямим повідомленням власника «Дозволу не запитувало ні разу».

Для linked worktree потрібна доставка project config. Нативного успадкування немає. Однаковий config скопійовано після перевірки Git-належності, а згоду записано один раз. В іншому репозиторії B інструмент відсутній.

Результат для основного сценарію **підтверджено**, повна acceptance matrix залишається частковою. Продуктовий install UI, відкликання в Desktop та перезапуск самого Desktop ще не перевірені. Для CLI застосований окремий ізольований профіль довіри, Desktop власник перевірив у своїй звичайній сесії застосунку. Ця проба не доводить роботу під довільними користувацькими або managed policies.

## Початковий етап і його межа

Частково. Локальний MCP-сервер видимий Codex CLI в checkout A з проєктним `.codex/config.toml`. У linked worktree того самого A, де немає власного config, сервер відсутній. В незалежному B сервер також відсутній.

Після цього власник дозволив продовжити пробу з доставкою конфігурації. Початкові докази збережено окремо від результатів продовження.

## Що виконано

- Субагенти `gpt-6-luna` написали MCP stdio заглушку, інтеграційні тести та fixture-скрипти. Продуктовий код Detent не змінювався.
- Заглушка має один інструмент `cross_review`, приймає spec/code і повертає `detent-probe:A:stub`. Вона не читає репозиторій і не запускає reviewer.
- П'ять subprocess-тестів проходять. Перевірено initialize, tools/list, spec/code calls, malformed JSON та невідомий tool. Під час огляду виправлено некоректний root `additionalProperties` у JSON Schema.
- Створено синтетичні A, A-linked і B з Git-комітами. A-linked належить A. Спочатку linked config був відсутній. У продовженні його матеріалізовано з A без нової згоди.
- Власник явно відповів «Дозволяю для A та його worktree». Точний текст запиту й результат записані в `evidence/consent.md`. Згода на передачу синтетичних матеріалів Anthropic отримана через чат. Продуктовий installer UI не будувався.
- `review-input.mjs` читає committed Git objects через абсолютний Git executable, перевіряє root/common-dir/worktree list, типи blobs, форми запитів та ліміт 1 MiB. Зовнішні diff/textconv вимкнені, успадковані GIT_* прибрані.
- `reviewer.mjs` запускає абсолютний Claude CLI без shell із fixed args, safe/restricted mode, порожніми tools/MCP, вимкненими hooks і окремим system prompt для untrusted review text. Timeout 180 секунд, output cap 1 MiB. Live init підтвердив порожні tools/MCP та нуль `tool_use`.
- Усього 18 focused тестів проходять. Перевірено протокол, доставку, небезпечні шляхи, сторонній Git repository, symlink blobs, порожній diff, input limit, помилки CLI, timeout і output overflow.

## Середовище та докази

Windows, Codex CLI 0.166.0, Claude Code 2.1.317, Node v26.12.1. Автор і керуюча модель OpenAI, рецензент Anthropic. Версію Desktop не встановлено.

Робочий каталог проби `.superpowers/sdd/2026-11-09-cross-review-mcp-probe/`. Код у `prototype/`, fixture paths у `prototype/setup-result.json`.

| Перевірка | Спостереження | Межа доказу |
| --- | --- | --- |
| `node --test prototype/stub.test.mjs` | 5/5 PASS | Протокол заглушки |
| `codex mcp list --json`, cwd A | detent_probe enabled | Завантаження проєктного config |
| Той самий виклик, cwd A-linked | detent_probe відсутній | Основний config не успадкований |
| Той самий виклик, cwd B | detent_probe відсутній | Сервер A не видимий із B за цим config |
| App-server `config/read`, cwd A | `tools.cross_review.approval_mode = "prompt"` в effective config | Налаштування прочитане хостом, поведінку prompt ще не перевірено |
| App-server `config/read`, cwd A-linked і B | Сервер відсутній, project config layer відсутній | Незалежне підтвердження CLI scope результату |
| Після доставки config, A й A-linked | Обидва effective config мають `cross_review.approval_mode="approve"` | `evidence/app-config-scope-after-delivery.json` |
| Нова CLI-сесія в A | Stub tool call completed, без approval | `prototype/evidence/live-a-isolated-profile.json` |
| Інша CLI-сесія в A-linked | Stub tool call completed, без approval | `prototype/evidence/live-linked-isolated-profile.json` |
| CLI, B, той самий профіль | `TOOL_ABSENT`, нуль MCP calls | `prototype/evidence/live-b-isolated-profile.json` плюс config/read absence |
| CLI, A, реальна специфікація | Claude знайшов суперечність 10 seconds / never expire | `prototype/evidence/live-spec-real.json` |
| Нова CLI-сесія, A-linked, реальний code review | Claude виявив підозріле `isReady('pending')`, root справді A-linked | `prototype/evidence/live-code-linked-real.json` |
| Специфікація з injection, проєктними hook/MCP/launcher | Маркер B не переданий, жоден canary не створений, reviewer має нуль tools/MCP/tool_use | `prototype/evidence/live-injection-real.json`, `injection-setup.json`, `injection-verified.json` |
| Прямий старт встановленого сервера з cwd B | Відмова ще під час startup через невідповідність Git-контексту | `prototype/evidence/server-b-rejection.txt` |
| Зміна approve → prompt, нова CLI-сесія A | MCP call failed до отримання reviewer result, потрібна згода | `prototype/evidence/live-revoked-prompt.json` |
| Та сама зміна, нова CLI-сесія A-linked | Та сама відмова | `prototype/evidence/live-revoked-linked-prompt.json` |
| Desktop, проєкт `test`, root A, spec review | Native mcpToolCall completed, правильний spec SHA, звіт про суперечність, нуль запитів дозволу | `evidence/desktop-manual.json`, `desktop-a.png` |
| Desktop, проєкт `test2`, root A-linked, code review | Native mcpToolCall completed, правильні base/head, звіт про дефект коду, нуль запитів дозволу | `evidence/desktop-manual.json`, `desktop-linked.png` |
| Desktop, проєкт `test3`, root B | Інструмент відсутній, MCP/shell/npx викликів у журналі немає | `evidence/desktop-manual.json`, `desktop-b.png` |

У live spec/code результатах є завершений `mcp_tool_call`, справжній model ID, commits/input hash, `effectiveRoot`, `registeredRoot` і init-підсумок reviewer з `tools=[]`, `mcp_servers=[]`, `toolUseCount=0`. Події started/completed одного item рахуються як один виклик.

Валідні CLI snapshots зберігаються у `prototype/evidence/cli-scope-corrected-initial.json` та `cli-scope-corrected-repeat.json`. Повторний запуск окремого процесу перевіряє повторюваність завантаження конфігурації. Він не доводить збереження користувацької згоди.

У першій версії fixture генератор помилково розміщував `approval_mode` на рівні сервера. Його виправлено на `[mcp_servers.detent_probe.tools.cross_review]`. Попередні snapshots із назвами без `corrected` збережені для історії помилки. Після виправлення обидва CLI scope snapshots повторено. `mcp list` не показує per-tool approval mode, тому цей спосіб його не підтверджує.

Додатковий доказ `evidence/app-config-scope.json` отриманий через app-server initialize + `config/read` з окремим cwd. Він підтверджує effective policy для A. App-server не починав сесію з моделлю й не викликав інструмент. Цей запуск не є live-тестом Desktop або реальної згоди.

Офіційні джерела описують project-scoped MCP і per-tool policy. Конкретну поведінку звіряли з установленим CLI. [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic).

## Налаштування та обмеження живого запуску

Нормальний `C:/Users/yuriy/.codex/config.toml` не змінювався. Спробу live-запуску з його завантаженням відхилила автоматична перевірка через ризик активації сторонніх інтеграцій. Цей запуск не повторювався. Безпечніша альтернатива пройшла перевірку й виконалася через `--ignore-user-config --ignore-rules --isolated-profile` у harness. Останній параметр передає Codex `-p detent-probe-isolated`.

За окремим схваленням створено `C:/Users/yuriy/.codex/detent-probe-isolated.config.toml`. Він містить тільки довіру до двох синтетичних checkout і підключається лише через явний `-p`. Права на review лежать у project config. Основну авторизацію Codex використовує його штатна CLI, auth-файли не копіювалися і їхній вміст не читався нашим кодом.

Ізольований профіль виявився потрібним для коректного trusted project loading з `--ignore-user-config`. На Windows ключ шляху довіри має відповідати native path. Початкові slash-normalized ключі та config-only checks дали хибне очікування щодо live-доступності. У доказах ці невдалі спроби збережено, вони не рахуються успішними перевірками дозволу.

Після огляду код сервера встановлено в `C:/Users/yuriy/.local/share/detent-probe/2026-11-09/review-v1/`, поруч створено нейтральний каталог reviewer. Сервер використовує встановлений `C:/Program Files/nodejs/node.exe`. У конфігурації старту прибрані NODE_OPTIONS/NODE_PATH. Код не імпортується з writable-проєкту. Окремі platform executable, signing і `.rules` не знадобилися для успішних CLI-викликів. Розташування поза writable roots не є доказом незмінності проти дій самого користувача чи privileged process.

Sandbox-схвалення машинних дій під час проведення проби рахуються окремо від дозволу MCP на review. Вони дозволяли встановити тестові файли та запустити CLI зі штатною state DB. Їх не можна подавати як доказ «одного діалогу на все встановлення».

## Неперевірені частини

Продуктовий install UI, первинна відмова користувача, відкликання в Desktop, перезапуск застосунку Desktop, оновлення пакета та інші напрямки родин моделей.

Відкликання перевірене через зміну per-tool mode з approve на prompt у двох project configs. Нові сесії завершили tool call помилкою `MCP tool call requires approval, but approval policy is never`. Неінтерактивний `codex exec` у цьому запуску не може показати користувацьке погодження, навіть коли caller передає on-request. Позитивні виклики з approve і негативні з prompt підтверджують застосування саме per-tool policy, але не вигляд діалогу в інтерактивній CLI чи Desktop. Після негативних перевірок відновлено approve на підставі чинної явної згоди власника. Нової згоди не запитували.

Окремий огляд коду субагентом `gpt-6-luna` не виявив Important/Critical проблем у межах прототипу. На момент огляду Desktop ще не був перевірений. Наступну ручну пробу власника записано нижче.

Агент не автоматизував Desktop-пробу через UI. Скіл Computer Use забороняє автоматизацію самого ChatGPT UI. Початковий огляд вікна не рахувався тестом його MCP-поведінки. Власник виконав пробу вручну й передав три скриншоти.

Після ручної проби native `list_projects` підтвердив `test` → A, `test2` → A-linked, `test3` → B. Через `read_thread` незалежно звірено cwd, параметри й completed-статуси двох MCP-викликів та відсутність tool calls у B. Журнали не містять shell/npx fallback. Власник окремо підтвердив нуль запитів дозволу. Native summaries не повертають повні reviewer receipts, тому model ID, init tools і effectiveRoot саме Desktop-викликів окремо не стверджуються.

Desktop thread IDs у локальному evidence — A `01a1c0f7-d7f4-7500-b4ad-a95d40c8ce34`, A-linked `01a1c0f9-ba4e-76c2-a825-e7ac83f5107a`, B `01a1c0fe-29a9-7983-a652-317c19589e31`. Нових чатів агент для цього не створював.

## Відтворення ручної перевірки Desktop

1. Додати як локальний проєкт `C:/Users/yuriy/.codex/worktrees/install-readiness/detent/.superpowers/sdd/2026-11-09-cross-review-mcp-probe/prototype/fixtures/A`. За потреби надати штатну довіру до тестового каталогу, зафіксувавши цей запит окремо від review consent.
2. У новому чаті попросити тільки MCP-виклик `detent_probe.cross_review` з `{ "kind": "spec", "path": "spec.md", "revision": "9572725bbc4c542b4aa6163bb5b2a15dc717241b" }`. Не використовувати shell/npx як fallback. Очікується звіт від Claude без нового review consent.
3. Повторити в іншому чаті, відкритому в локальному `.../prototype/fixtures/A-linked`, із `{ "kind": "code", "base": "fc5fb1722fab16d5ed6f1261febc8b57763e5cc7", "head": "9572725bbc4c542b4aa6163bb5b2a15dc717241b" }`. Перевірити `effectiveRoot`, commits і reviewer init у tool result.
4. У локальному `.../prototype/fixtures/B` такого інструмента бути не повинно. Записати кількість усіх prompts. Якщо Desktop додасть окрему згоду на сервер або tools, це частковий результат щодо єдиного дозволу між клієнтами.

Ці кроки вже виконав власник. Ізольований CLI-профіль не вмикався як default конфігурація Desktop нашим кодом.

## Подальше рішення

Для перевірених Codex CLI та Desktop достатньо звичайного встановленого Node-пакета, вузького MCP-інструмента, project config і доставки цього config у worktree. Є підстава оновити специфікацію й скласти harness-план install/skills/doctor без платформного release/signing. У специфікації залишити явні acceptance checks для installer-відмови, Desktop revocation/restart та кожного додаткового адаптера родини моделей.

Тестовий профіль, зовнішній каталог встановлення та фікстури залишені для відтворення. Глобальних MCP registrations і постійних shell allow rules немає. Прототип не комітився. Тимчасові test repos залишаються під `%TEMP%/review-input-test-*`. У ранніх тестах прибиралися лише власні щойно створені test repos, після огляду recursive cleanup вилучено. Ранні fixture-тести також змістили A HEAD, тому live-review використовують явно зафіксовані commits.
