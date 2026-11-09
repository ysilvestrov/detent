# Д-1: довірений Detent host поза writable-проєктом

Дата: 2026-11-09
Статус: чернетка — поправка потребує затвердження перед реалізацією host/дозволів
Spec-review: claude/default @ e6ba55d (author: codex) — 9 findings: 9 fixed, 0 rejected

## Для власника

### Мета

Дати Codex придатну для перевірки межу довіри для повторного запуску cross-review:
постійний дозвіл стосується незмінюваного для sandbox коду, а проєкт передає лише дані.
Це поправка до [специфікації встановлення](2026-11-09-install-readiness-design.md),
а не твердження, що постійні дозволи вже працюють у Codex desktop.

### Що зміниться для тебе

Окрім файлів проєкту, встановлення запропонує окремий платформний Detent host у каталозі
користувача **поза всіма writable roots і temp sandbox**. Його встановлення/оновлення
та точне правило для конкретного executable і реєстрації репозиторію погоджуються окремо. Старі версії
залишаються для старих worktrees. Claude та Antigravity зберігають чинний `npx`-шлях.

Релізи отримають платформні executable, їх перевірку походження й OS-signing там, де
цього вимагає ОС. На цій Windows непідписаний пробний executable заблокував Application
Control: без прийнятного для ОС артефакту host лишається недоступним, політику не вимикаємо.
Запис правила не є доказом його застосування. При managed deny або неперевіреному хості
setup залишається неповним; встановлення не обіцяє «дозвіл назавжди».
Після застосування allow cross-review запускається **поза sandbox без нового запиту**:
host пише до погоджених Git metadata/tmp, запускає reviewer CLI з їхніми credentials
та може витрачати їхні платні ліміти. Захист інструментів дочірнього reviewer не
успадковується від батьківського Codex sandbox і має бути окремо доведений. Згода
охоплює також нові worktrees, підтверджені захищеними metadata цього репозиторію;
це ширше за один root, але не дозволяє довільні каталоги чи інші репозиторії.

### На чому стоїть рішення

- Власник обрав дослідити launcher поза writable-проєктом і підготувати цю поправку.
  `[вимога власника]`
- `.detent/run.mjs` за базовим дизайном лежить у writable-проєкті; що агент здатний
  змінити його за таких прав — `[виведення]`, а не результат модельного review.
  Постійний allow на цей код — відкинута альтернатива базової специфікації. П-1
  документує лише отримане зауваження, не доводить експлуатацію.
- Звичайний Node завантажує код із `NODE_OPTIONS` до entrypoint. `[проба]` П-2.
- Node SEA документує `execArgvExtension: "none"`, але виконання побудованого executable
  на цій машині заблокувала ОС. `[проба]` П-3. SEA — кандидат, не доведена сумісність.
- Вузький prefix exact binary/project зіставляється Codex CLI 0.166.0; інший project
  не зіставляється. `[проба]` П-4. Завантаження правила desktop цим не доведене.
- Припущення про можливість поставляти прийнятні для всіх цільових ОС артефакти
  лишається непідтвердженим. `[виведення]` — це gate, не висновок, що signing розв'яже
  локальну відмову. Наявність signature сама не гарантує дозвіл Application Control.

### Ключові рішення

1. **Довірений host містить код виконання, а не запускає проєктну копію CLI з підвищеними
   правами.** Альтернатива — зовнішній verifier, що після перевірки імпортує JS із проєкту;
   відкинуто через race між перевіркою/виконанням і mutable imports. Довірений host
   виконує лише свій embedded або захищений встановлений набір.
2. **Платформний executable, стійкий до pre-entry injection.** Розглянуто стандартне:
   абсолютний `node trusted.js` — не достатній сам по собі через NODE_OPTIONS. SEA з
   вимкненим execArgv extension — кандидат; підписування й OS loader/environment
   перевіряються окремо. Не вводити широку allow-команду для `node`, shell або `npx`.
3. **Постійний scope — exact host build + захищена реєстрація репозиторію та його
   Git-зареєстрованих worktrees.** Новий build/інший репозиторій потребує нового дозволу.
   Новий root того самого репозиторію перевіряється host при кожному виклику за захищеними
   metadata, а не потребує нового user rule. Відкинуто per-worktree prefix: якщо правила
   вантажаться тільки при startup, нова сесія могла б повторювати setup безкінечно.
   Відкинуто дозвіл на будь-який шлях, який лише заявляє той самий repository id.
4. **Вузькі правила хоста користувача — явно погоджена нова область запису.** Базова спека
   забороняла зміну global/user rules. Ця поправка дозволяє лише окремий Detent-файл
   у підтриманому user rules layer, з exact diff та project scope; без зміни default
   rules, повної Auto-review policy, managed requirements чи загального sandbox-профілю.
5. **Core runtime не видається за завершений setup.** Уже написані контракт/реєстр/store
   залишаються механікою копіювання й цілісності. Проєктна копія може працювати всередині
   sandbox, але зовнішній allow не викликає її. Старе завдання про elevated project launcher
   не реалізується. Точна інтеграція готується лише після затвердження цієї поправки.

### Що стане гірше

Замість суто Node-пакета потрібен випуск платформних артефактів, їх signing/перевірка
походження та оновлення. Для SEA це додатковий розмір вбудованого Node. Старі builds і
generation накопичуються; автоматичного видалення немає, прибирання — окремий guarded
script із dry-run та згодою власника за конституцією. У full-access середовищі або при
додаванні каталогу host до writable roots захист незмінності зникає: цей режим не отримує
гарантії даної поправки.
Потрібне нове правило для нового build/репозиторію; новий worktree того самого
репозиторію входить у явно погоджений scope. Git hooks не виконуються; проєкти, де
файли для review потребують LFS/smudge filters, не отримають privileged review без
окремо погодженого безпечного materialization-шляху. Замість прихованого review pointer
або raw-файлів host явно відмовляє; це видима втрата сумісності для таких проєктів.

### Оцінка

Попередня оцінка власника основної зміни: L. Автор: **XL після цієї поправки**, бо додаються
платформний випуск/довіра до бінарника та окрема інтеграція host. Пропонована розбивка:
ядро інсталяції 25%, trusted host й обмеження делегування 30%, release/signing 25%,
Codex CLI/desktop integration та live-матриця 20%. Це прогноз, не замір.

Дешевше: лишити проєктний launcher і можливі повторні approval. Власник обрав дослідження
іншого шляху; дешевший варіант не відповідає цілі постійного вузького дозволу.

### Питання до власника

1. Чи затверджуєш зовнішній платформний host, окремий user rules file і збільшення scope
   до платформного випуску/signing? Без цього новий host не реалізується.
2. Чи прийнятний repository scope із новими Git-зареєстрованими worktrees та явна відмова
   privileged review для файлів, що потребують filters/LFS, до появи безпечного materialization?

Розглянуто стандартне: вузький sandbox permission profile із Git metadata/tmp та
потрібними reviewer resources — пріоритетна альтернатива для проби перед release-design.
Самого `sandbox_workspace_write.writable_roots` може бути недостатньо через захищені
Git paths і записи reviewer state; фактична сумісність CLI/desktop та network boundary
не перевірені. Режими permission profiles і legacy sandbox settings не змішуються
([Codex permissions](https://learn.chatgpt.com/docs/permissions)). Якщо профіль доведе
ту саму ціль без зовнішнього host, owner section переглядається: складніший host не
реалізується за інерцією. Д-1 пропонує досліджений кандидат, не оголошує стандартний
варіант неможливим без проби.

## Проби

### П-1. Повторне рев'ю основної специфікації

`node dist/cli.js cross-review --author codex --spec docs/specs/2026-11/2026-11-09-install-readiness-design.md`
на `78cfc3f`: Claude повернув 9 зауважень. Перше — заборона persistent allow на mutable
project JS суперечить основній цілі. Власник після повідомлення обрав дослідити зовнішній host.
Звіт лишається в root checkout `tmp/cross-review-spec-claude-codex-install-readiness-spec-78cfc3f-OjyZPu/report.md`.

### П-2. Pre-entry injection у звичайний Node

Windows, Node `v26.12.1`. У тимчасовому каталозі створено два файли: `main.cjs` друкує
`HOST-ENTRY`; `preload.cjs` друкує `PRELOAD-EXECUTED`. Перед запуском лише дочірнього
Node задано `NODE_OPTIONS=--require "<temporary-path>/preload.cjs"`; змінну процесу
відновлено після проби. Вивід:

```text
PRELOAD-EXECUTED
HOST-ENTRY
```

Прибирання NODE_OPTIONS всередині trusted.js запізнюється. Див.
[Node CLI](https://nodejs.org/download/release/v26.8.2/docs/api/cli.html#node_optionsoptions).

### П-3. SEA та обмеження ОС

`node --build-sea=<temporary-path>/sea.json`, конфігурація містить
`execArgvExtension: "none"`, `execArgv: ["--no-addons"]`. Збірка завершилась
`Generated single executable ... detent-host.exe`. ОС відмовила в запуску:

```text
An Application Control policy has blocked this file.
```

Це відмова Windows Application Control, не npm і не автоматичний review Codex.
Обхід не робився. SEA-властивість і платформи описані в
[Node SEA](https://nodejs.org/download/release/latest-lithium/docs/api/single-executable-applications.html).
Локальна проба не довела запуск, ігнорування NODE_OPTIONS бінарником, signing або захист
від OS loader injection (LD_PRELOAD, DYLD_* тощо). Усе це acceptance gate.

### П-4. Scope правила Codex, лише offline

`codex-cli 0.166.0`, тимчасовий `.rules` із pattern
`["<absolute-host-exe>", "cross-review", "--project", "C:/Projects/detent"]`.
`codex execpolicy check --rules <temporary-rules> -- <host-exe> cross-review --project C:/Projects/detent --author codex`
повернув `decision: "allow"`; для `--project C:/Other/project` — `matchedRules: []`.
Жоден активний файл правил користувача не змінювався. Це перевірка matcher над файлом,
не доказ завантаження правила або дозволу поточного desktop.
[Правила Codex](https://learn.chatgpt.com/docs/agent-configuration/rules).

## Контракт host, який треба довести до реалізації дозволів

1. Розміщення — per-user каталог даних ОС (наприклад `%LOCALAPPDATA%/detent/hosts/` на
   Windows), поза проєктами, temp і фактичними writable roots. Назва user-каталогу сама
   не доводить захист: installer/doctor перевіряє active policy; за відсутності доказу
   постійний allow не пропонується. У runtime-гілці жодного встановлення або оновлення host.
2. Шлях host включає точні version/build digest; файл не перезаписують для оновлення.
   Бінарник та весь виконуваний ним код не завантажуються зі змінюваного проєкту або
   його node_modules. Installation provenance/signature перевіряються незалежно від
   checksum, що поставляється поруч із тим самим недовіреним файлом. Конкретний формат
   підпису/дистрибуції — окремий release-design перед реалізацією.
3. Визначена команда — `<absolute-host> cross-review --registration <opaque-id> --project <canonical-root> ...`.
   Parser відкидає дублікати `--project`, зайві підкоманди, довільний script path,
   eval/import/loader flags. Саме ця канонічна форма має бути видима в native approval.
   Project launcher/локальний receipt не може змінити host build або зареєстрований
   repository scope, погоджений правилом.
   Prefix rule закінчується на exact `--registration <opaque-id>`; змінюваний project
   перевіряє host за цією реєстрацією, його не приймають як необмежений trailing path.
4. Реєстрація лежить поза agent-writable scope і прив'язує build, канонічний Git common-dir,
   repository identity та scope. Host через pinned Git читає `worktree list --porcelain -z`
   зареєстрованого common-dir й окремо перевіряє root/common-dir фактичного project.
   Тільки наявний Git-зареєстрований worktree цього repo допускається. Сам `.git` файл
   у writable-проєкті, opaque-id або спільна назва каталогу не надають дозволу. Якщо
   active policy дозволяє агенту змінювати ці Git administrative metadata без окремої
   згоди, ця схема membership не є довіреною й persistent allow не активується.
   Усі path-bearing аргументи й поля конфігурації (включно з `--spec`, specsDir, tmpDir,
   prompt overrides і report destinations) обмежені канонічним зареєстрованим проєктом.
   Absolute paths не можуть змінити scope; traversal, symlink/junction/hardlink escape,
   дублікати параметрів і redirect outputs поза scope відхиляються до читання/запису
   чи передачі даних рев'юеру. Для запису потрібна стійкість до reparse/TOCTOU, а не
   лише попередня перевірка рядка realpath; core store сам по собі такої privileged
   гарантії не дає. Зовнішні Git common-dir/worktree metadata, host store й інші
   необхідні capabilities реєструються окремо з точними read/write межами під час setup.
   Збіг repository id не надає доступу до файлів іншого checkout. Auth самого reviewer
   CLI лишається явно погодженою можливістю, не дозволом host читати довільні user-файли.
5. До будь-якого privileged виконання host виключає можливість project-controlled коду:
   він не import-ить проєктні JS, не запускає package scripts і не шукає git/reviewer
   executable в project PATH. Абсолютні шляхи до git та дозволених reviewer CLI, їхні
   Node-shim targets і довіра до них перевіряються під час setup.
   Для npm `.cmd` shim потрібен **окремо зареєстрований абсолютний Node interpreter**:
   fallback на `process.execPath` усередині SEA заборонено, бо це host, а не Node.
   Шлях interpreter та JS target перевіряються поза writable scope; child Node стартує
   з очищеним середовищем до виконання JS. `NODE_OPTIONS` для нього не успадковується.
   Дитяче середовище
   очищене від code-loading/перевизначення executable/config (NODE_OPTIONS/NODE_PATH,
   loader env, shell startup variables, GIT_CONFIG_* та аналогів). Ін'єкція **до** entrypoint
   host має блокуватися самим artifact/хостом ОС, не лише чисткою env у JS.
6. Git operations не виконують проєктні hooks або filters у privileged host; їх
   нейтралізація й checkout-семантика мають окремі негативні тести. Конфіг/промпти Detent
   залишаються даними. Reviewer обмежується чинним read-only adapter, але підтвердження
   захисту його shell/MCP поверхонь лишається окремою вимогою; зовнішній host не робить
   `agy` MCP автоматично безпечним.
   До review перевіряються Git attributes/filter dependencies файлів у scope. Якщо без
   filter/LFS неможливо отримати потрібний вміст, host завершує явною відмовою до запуску
   reviewer; pointer/raw content не видається за матеріалізований review snapshot.
7. Нативні налаштування Codex CLI/desktop не вважаються тотожними. Setup може встановити
   файли й показати rule proposal, але лише live host outcome у новій сесії доводить
   фактичну поведінку. Коли read-only API застосованої policy відсутній, status розділяє
   `configured`, `verified-in-session`, `needs-action`; немає фальшивого `setup complete`.
   `verified-in-session` — лише спостереження з timestamp, session id (якщо наданий хостом),
   host build та policy fingerprint. Воно не авторизує майбутній запуск і не читається
   host як capability. Поточну registration/membership/scope host перевіряє заново.
   Branch switch у зареєстрованому repo не змінює довірений host-код; config з нової
   гілки знову перевіряється як дані. Move/copy root або зміна common-dir вимагає
   повторної membership/identity перевірки, а інший repo/build — нового setup.
8. OS application control, managed deny, непідтверджена незмінність або code-loading
   gate → fail closed, чітка причина й підтриманий ручний шлях. Немає вимикання політики,
   обходу відмови, переведення в Full Access або мовчазного downgrade до mutable project JS.

## Взаємодія з основною специфікацією

Після затвердження Д-1 замінює частину про дозволений privileged entrypoint: project
launcher може працювати всередині sandbox, але persistent allow має викликати саме host.
Приватний host store та user rules file — нові, окремо погоджувані targets запису.
Контракт inventory, генерації й atomic registry лишається корисним для копій, але не є
доказом довіри до executable або дозволом на його зовнішній запуск.

До затвердження не змінювати встановлення, скіли або активні permissions згідно з новою
архітектурою. Два початкові core-кроки вже реалізовані та перевірені; вони не під'єднані
до CLI й не змінюють чинну поведінку користувачів.

## Приймання та докази

| Заявка | Необхідний доказ |
|---|---|
| Host не змінюється sandbox-агентом | фактичний write-denial для binary, executable dependencies та registration; не лише розташування поза repo |
| Host не виконує preload | запуск із malicious NODE_OPTIONS/loader env на кожній платформі; sentinel не виконався |
| Підписаний артефакт працює на ОС | запуск на Windows із чинним Application Control та відповідні Linux/macOS перевірки |
| Правило обмежене repository/build | exact registration позитивний; інший repo/build, незареєстрований worktree, duplicate flags, env wrappers, project script path — негативні; новий валідний linked worktree не потребує нового правила |
| Scope обмежує дані та побічні дії | project A + --spec project B, tmpDir/report поза A, traversal і reparse race не читають/не передають/не пишуть за scope; зовнішні metadata працюють лише за окремою реєстрацією |
| Код проєкту не отримує privileged виконання | malicious PATH shim, Node shim target, Git hook/filter, project imports не виконуються |
| Дозвіл застосований хостом | нова сесія Codex CLI і desktop з зафіксованими policy/version; check над rules-файлом недостатній |
| Старий worktree лишається на своєму build | main v2 та worktree v1, два захищені builds; жодного silent upgrade |

## Заявка → доказ

| Заявка | Де фіксується | Що доводить | Сила |
|---|---|---|---|
| Repository/build зареєстровано | захищений host registration store | явне погодження root/common-dir/build/capabilities, provenance host, OS-захист store; при кожному запуску повторна перевірка identity та membership | capability лише за чинної довіреної межі, не project receipt |
| Правило записано | окремий Detent user rules file, setup report | точний детерміновано відновлений diff, підтвердження користувача та readback | configured, не доказ завантаження правил хостом |
| Правило застосувалося в сесії | діагностичний запис verified-in-session | фактичний outcome native host, session/time/build/policy context | історичне спостереження, не авторизація наступних дій |
| Worktree входить у scope | runtime-рішення host, diagnostics | поточний pinned Git listing захищених metadata та окремий збіг root/common-dir | перевіряється кожен виклик, старий listing не кешується як дозвіл |
| Host прийнятий ОС | release compatibility matrix | запуск конкретного підписаного/дозволеного artifact під реальною policy на кожній платформі | локальна сумісність; сам signature не доводить дозволу |
| Потрібна дія | needs-action з причиною | відсутній актуальний доказ, OS/managed deny, mismatch або filter dependency | явний неповний стан, без fallback |

## Рев'ю поправки

Builder check виконано окремим агентом: зауваження про неповну data-boundary для trailing
args/config прийнято; додано confinement інваріант, окрему реєстрацію зовнішніх capabilities,
негативні acceptance-випадки та вимогу стійких до TOCTOU записів. Cross-review Claude
на `e6ba55d` повернув 9 зауважень. Проби вище не є live-матрицею працездатного Detent host.
Реалізація host/permissions очікує рішення власника й release-design.

| # | Рішення | Зміна |
|---|---|---|
| 1 | прийнято | per-worktree rule замінено на явно погоджений repository scope; membership перевіряється host за захищеними metadata, щоб нова сесія не вимагала нового правила |
| 2 | прийнято | owner section прямо називає запуск поза sandbox без prompt, Git writes, reviewer credentials/ліміти та окремий захист child surfaces |
| 3 | прийнято | SEA process.execPath не використовується для npm shims; потрібен зареєстрований окремий Node та очищене child env |
| 4 | прийнято | filters/LFS incompatibility видима власнику; при необхідності materialization host явно відмовляє, не рев'ює підмінений raw snapshot |
| 5 | прийнято | parent повернуто до очікування Д-1; оцінка розширеного scope — XL, старе L історичне; scopes запису розмежовано |
| 6 | прийнято | додано claim/evidence table, lifetime registration та distinction observation/capability; branch/move/membership перевіряються заново |
| 7 | прийнято | вузький sandbox profile включено як стандартний пріоритетний кандидат для проби; неможливість не заявляється без доказу |
| 8 | прийнято | model review не називається пробою writable launcher; недоведена доставка прийнятних artifact явно є гіпотезою |
| 9 | прийнято | немає твердження, що signing зніме Application Control block; доказом є тільки реальний запуск під policy, підпис окремо недостатній |
