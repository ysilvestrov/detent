# Завершене встановлення Detent і проєктний дозвіл на cross-review

Дата: 2026-11-09
Статус: затверджено продовженням власника 2026-11-09, реалізацію розпочато
Spec-review: claude/default @ 8a1d7c7 (author: codex) — 12 findings: 12 fixed, 0 rejected

Ця редакція замінює попередній privileged launcher та пропозицію платформного host з Д-1. Попередні рішення й рев'ю доступні в Git. Поточний продукт ще не реалізує цей контракт. Уже написані runtime contract/store є придатними для повторного використання частинами.

## Для власника

### Мета

Після встановлення всі чотири скіли доступні в обраних агентах. У Codex одна згода для проєкту дозволяє повторні безпечні рев'ю committed-специфікацій та PR-коду локально встановленою CLI іншого сімейства.

### Що зміниться для тебе

Явний `detent install` запропонує встановити пакет поза writable-проєктом і дозволити один інструмент рев'ю для цього репозиторію та його Git-зареєстрованих worktrees. У запиті будуть версія, шляхи, провайдери й використання їхніх облікових записів та лімітів. Одна згода охоплює цей план, подальші рев'ю проходять без нових погоджень. Автентифікація reviewer CLI та штатна довіра хоста до каталогу є окремими передумовами.

Перший text-only adapter для Codex — Claude CLI з чинною авторизацією. Поточний agy-fallback у Codex MCP-шляху ще не підтверджений і недоступний до окремої проби. Відсутність придатного Claude дає неповний setup. Legacy CLI-шляхи Claude/Antigravity зберігають свій чинний вибір reviewer.

Claude Code та Antigravity зберігають чинний npx-шлях і формат встановлення скілів. Codex отримує локальний MCP-інструмент. Інсталятор доставляє погоджену конфігурацію у worktree. Зміна версії, доступів чи переліку провайдерів потребує явного install/update. Видалення попередніх копій є окремою операцією.

### На чому стоїть рішення

- Один проєктний дозвіл та інша родина reviewer — `[вимога власника]`.
- CLI перевірено з ізольованим профілем та --ignore-user-config/--ignore-rules. Desktop власник перевірив у своїй сесії й повідомив нуль запитів дозволу в усіх трьох тестах. A/A-linked успішні, B без інструмента — `[проба]` П-8. Це результат конкретного середовища, передумова штатної довіри не є новим review grant.
- Project MCP config не успадковується linked worktree автоматично, доставка однакового config працює — `[проба]` П-8.
- Звичайні Node-модулі поза writable roots забезпечили перевірений запуск. Signing не був потрібен для цієї проби — `[проба]` П-8. Інші ОС і версії хостів потребують перевірок.
- Захист коду й host config перевіряється для обраної permission surface перед grant. Codex :workspace документує read-only .codex, підтримка іншої політики потребує еквівалентного доказу — `[проба]` П-9 для фактичного середовища та `[виведення]` для майбутніх конфігурацій. Full-access не отримує гарантії sandbox.

### Ключові рішення

1. Один локальний MCP-інструмент з вузькими параметрами та project-scoped policy. Розглянуто постійний shell-prefix на launcher у проєкті, відкинуто через можливість підміни коду. Платформний executable/signing з Д-1 вилучено з поточного обсягу за результатами П-8.
2. Звичайний самодостатній Node-пакет у локальному захищеному каталозі. Розглянуто імпорт з node_modules або проєктної runtime-копії, відкинуто для privileged MCP через writable-код.
3. Reviewer отримує committed-текст і працює без інструментів. Розглянуто агентне читання checkout і запуск тестів, відкинуто для цієї capability через ширші права й побічні дії.
4. Згода належить конкретному репозиторію, установленій версії та погодженим провайдерам. Native config і protected state мають бути недоступні агентним записам, а installer grant потребує довіреного user/host approval channel. Новий worktree отримує той самий config після перевірки Git-належності. Розглянуто ручне підтвердження кожного рев'ю, відкинуто як несумісне з метою.
5. Доставка скілів, effective permissions і live-доступність показуються окремо. Розглянуто один зелений статус після копіювання, відкинуто через відмінність цих фактів.

### Що стане гірше

Потрібні локальна копія пакета й конфігурація MCP у кожному worktree. Клон і переміщення проєкту потребують setup. Reviewer не шукає по checkout і не запускає тести. Перевірки конституції, відповідності реалізації та повторного використання коду мають явне «не перевірено», якщо потрібний контекст не передано. Сумарний payload обмежено 1 MiB разом із повними head blobs усіх змінених текстових файлів, тому одна правка lockfile понад 1 MiB також відхиляється. Binary/submodule/LFS-material і неоднозначний merge-base отримують явну відмову. Tracked .codex/config.toml потребує рішення користувача щодо локальної конфігурації. Scripts для .agents мають врахувати новий exit 6.

### Оцінка

Власник L. Автор L, прогноз 2–3 PR. Інсталяція й транзакції 30%, MCP/згода/worktrees 30%, renderer скілів і сумісність 15%, doctor та live-матриця 25%. Попередню XL-оцінку Д-1 замінено після відмови від платформного release/signing. Дешевший варіант з одним виправленням текстів скілів лишає повторні запити й не виконує мету.

### Питання до власника

Нових відкритих питань немає. Потрібне затвердження оновленої архітектури перед продуктовою реалізацією.

## Контекст і сумісність

Джерела істини — цей документ і чинні специфікації review protocol. Непов'язана npm-cache ENOENT має окремий issue #29. Мовчазного повторного npm download у Codex review path немає.

Зберегти `install`, `--claude`, `--agents`, `--superpowers yes|no`, `--dry-run`. Без target-прапорів доставляються обидва чинні набори. .agents/skills є спільним набором Codex/Antigravity, дублікати не створюються. Claude plugin лишається додатковим каналом доставки.

`detent:run` renderer працює поруч із чинним `detent:author`. У спільних .agents текстах явно розділені Codex MCP і чинна Antigravity-команда. Claude .claude/skills, plugin, CLAUDE.md отримують чинний scoped npx. Наявність Codex MCP не є умовою встановлення або роботи Claude/Antigravity. Конституція, spec-format і всі скіли мають узгоджені команди запуску. Bare `npx detent` у доставлених текстах не використовується.

Додати `--hosts codex-cli,codex-desktop,agy` незалежно від targets. Невідомий/порожній id та `--hosts claude` дають usage exit 2. Сам факт наявності executable не обирає хост. Для .agents без --hosts інтерактивний install просить вибір, без доступного каналу вибору повертає новий exit 6 після доставки файлів. Для agy показується чинна точна npx-команда й ручна інструкція дозволів, без запису host policy. Цей статус не блокує setup exit 0. Install тільки --claude зберігає чинні exit-коди, не встановлює MCP/runtime й не питає Codex permissions.

## Встановлений пакет і межа виконання

Bootstrap є явною операцією з конкретного релізу, наприклад `npx -y @ysilvestrov/detent@<version> install`. Уже встановлений локальний пакет також може бути джерелом install. Повторні review не використовують bootstrap.

Для обраного Codex-хоста install копіює отриманий реліз в `<user-data>/detent/packages/<version>/<digest>/<generation>/`. Стандартне user-data визначається ОС, у Windows кандидат %LOCALAPPDATA%/detent. Каталог має бути поза усіма writable roots обраного хоста та temp sandbox. Якщо хост не дозволяє перевірити цю межу, результат needs-action. Каталог усередині ширшого writable ancestor не є захищеним.

Копіюються package.json, dist, prompts, skills, constitution. Поточний пакет не має runtime dependencies. Їх поява потребує перегляду самодостатнього інвентарю. Повторний npm resolve або install усередині копіювання не потрібний. Абсолютний захищений Node executable і встановлений MCP-entrypoint фіксуються в конфігурації. NODE_OPTIONS/NODE_PATH очищуються до старту Node. Для subprocess використовуються абсолютні Git/reviewer executable, shell=false, фіксовані args та очищене від execution/preload overrides оточення.

Жодний модуль виконання, package loader, helper чи prompt-system-template не імпортується з проєкту. Проєктні prompts і матеріали розглядаються як untrusted data. Перевірка хешів доводить цілісність копії, довіра до релізу спирається на явно авторизоване встановлення. Інвентар не є publisher signature.

Повторно використати codecs, hashes, contract validation і принцип generation з уже реалізованого core. Чинний RuntimeStore має project-root layout і fail-fast lock, він не стає захищеним store без адаптації. Узагальнення layout та збереження чинної поведінки робляться окремим like-for-like refactor PR, потім protected layout додається поведінковою зміною. Package lock і project writer lock різні. Старі generation лишаються, repair публікує нову повну generation, config переключається тільки після її перевірки. Worktrees зберігають pinned version/digest. Проєктний elevated launcher вилучений.

## Проєктна прив'язка і worktrees

Прив'язка в захищеному локальному install state містить main checkout root, Git metadata identity, version/digest, дозволених reviewer/model/provider, host selection і hash погодженої capability. Це невеликий локальний запис для одного встановлення проєкту, без окремого сервісу чи довірчої бази.

Один захищений project record охоплює всі його версії та worktrees. Він містить enabled/revocation revision, погоджені capability hashes і inventory canonical worktree/config paths із pinned version/digest та станом pending/active. Перед першим config write під project lock атомарно додається pending entry, після перевірки запису він стає active. Recovery та revoke бачать обидва стани. Відсутній/offline worktree не вилучається мовчки. Видалення запису можливе лише після перевіреного Git-unregister або явного погодження користувача, без видалення його файлів.

Корінь поточного запиту береться із перевіреного хостом контексту MCP-процесу. Cwd визначається до переходу в нейтральний reviewer-каталог. На кожному виклику перевіряються canonical root, точний checkout toplevel, common metadata identity і присутність у Git worktree list. Tool parameters не можуть підміняти root чи metadata path. Зміна cwd/session root після запуску означає refresh/restart MCP, а не стару прив'язку.

Common-dir сам по собі не визначає checkout root. Для звичайного main layout відокремлено перевіряється root/.git. Для separate-git-dir потрібна явна реєстрація обох canonical paths під час install. Bare repository без робочого checkout відхиляється. Неперевірені layout не отримують припущення про parent(metadata). Symlink/reparse aliases, заміна metadata та зміна зареєстрованих шляхів означають needs-action до нового setup.

Уточнення за реальною Git-пробою під час реалізації. Worktree list читається завжди. Для звичайного main потрібні canonical root/.git directory == registered common-dir і mainRoot у списку. При separate-git-dir Git показує primary worktree як шлях metadata. Тоді незалежно перевіряються canonical regular mainRoot/.git file, show-toplevel == mainRoot, absolute-git-dir == common-dir == зареєстровані metadata і primary list entry == common-dir. Linked caller завжди має власний явний root entry. Корінь не виводиться з parent(common-dir). Це деталізація вже погодженої явної прив'язки separate layout, scope доступу не розширюється.

Project config у main checkout та кожному linked worktree вказує на ту саму pinned package/registration. Копіювати запис можна лише після перевірки належності worktree й чинного scope згоди. Існуючий відмінний запис не перезаписується. Для звичайних майбутніх worktrees доставка виконується явним `detent install --agents --hosts ...` у цьому worktree, повторної згоди на незмінну capability немає. Скіли при відсутньому інструменті показують цей setup-крок. Автоматичне спостереження за worktree creation або hooks не додаються.

Різні version/digest можуть співіснувати у worktrees. Оновлення main не перемикає config старого worktree. Перенесення/клонування та зміна Git identity вимагають нового install. Пошук коду відносно metadata або імпорт з main checkout не використовуються.

## Згода і конфігурація Codex

Мінімальна поверхня має один сервер `detent` і один tool `cross_review`. В existing namespace collision install показує conflict і не затирає сторонню конфігурацію.

Приклад структури для підтриманого Codex наведений як продуктова форма перевіреного П-8-контракту.

```toml
[mcp_servers.detent]
command = "<absolute protected node>"
args = ["<installed entrypoint>", "mcp", "--registration", "<protected project binding>"]
env = { NODE_OPTIONS = "", NODE_PATH = "" }
enabled_tools = ["cross_review"]

tool_timeout_sec = 930

[mcp_servers.detent.tools.cross_review]
approval_mode = "approve"
```

Застосовується тільки project .codex/config.toml. Інсталятор зберігає сторонні TOML-ключі й коментарі. Потрібна штатна довіра хоста до проєкту. Правила запуску shell, глобальні MCP, global/default user config, managed policy та permission profiles цим встановленням не змінюються. Ізольований профіль у пробі був лабораторним способом запустити CLI без сторонніх інтеграцій, він не є вимогою продукту.

Машинний .codex/config.toml є локальним і не комітиться. Install додає точний ігнорований шлях у власний керований блок .gitignore зі збереженням інших правил. Якщо файл уже tracked, до запису абсолютних шляхів/approve виникає conflict exit 4, прихований skip-worktree або untrack індексу не застосовуються. Це не привід ігнорувати весь .codex чи сторонні зміни. Після коміту погоджених артефактів install legacy git-status preflight має лишатися чистим.

Перед записом один запит охоплює точний file/config diff, package version/digest, repository/worktree scope, перелік reviewer-провайдерів, передачу committed матеріалів, платні ліміти й нейтральні тимчасові записи. Читання credential-файлів нашим кодом не дозволяється. Авторизована reviewer CLI використовує власний штатний auth.

Native .codex config, package і registration paths перевіряються на недоступність агентним записам у фактичному permission contract, включно з writable ancestors/aliases. Grant заборонено, якщо агент може підмінити command/args. Звичайна присутність каталогу в проєкті не є доказом захисту. Керований ignore entry та untracked стан config перевіряються як compatibility conditions під час install/doctor, їхня зміна дає needs-action. Якщо current host proof не охоплює захист виконуваного коду й native config, approve не записується.

Додати `--permissions ask|apply|skip`, типово ask. При ask без TTY створюється локальний proposal й точна apply-команда, зависання чи автоматичної згоди немає. Агент може передати пропозицію користувачеві один раз. Відмова/skip лишає файли скілів, але не записує approve і не дає unattended-ready.

Apply приймає `--proposal <path> --expect-hash <sha256>`. Hash доводить лише цілісність пропозиції. Grant виконується інтерактивним користувачем або installer-процесом, чий точний restricted write/command scope погоджений через trusted native host approval. Chat interpretation, самодекларований approval flag/environment і possession proposal hash не є машинним доказом згоди. Агент у sandbox не може записати захищені config/state або видати такий grant самостійно. За відсутності каналу підтвердження apply дає needs-action/6. Результат містить джерело підтвердження, а не твердження про криптографічну атестацію чату.

Apply повторно виводить допустимі paths і capability зі встановленого пакета, перевіреного проєкту та schema, а не виконує довільні paths/команди з proposal. Під writer lock звіряються hashes попередніх файлів, Git metadata, версія, namespace collision й актуальність host-approved scope. Застарілий proposal дає conflict без записів.

Повторний install того самого version/digest і незмінного scope звіряє захищений запис згоди та effective host config. Зміна версії, провайдерів або прав показує новий план update для одноразового погодження. Відкликаний/змінений користувачем native grant не відновлюється мовчки зі старого запису згоди. Новий worktree не відновлює відкликаний grant інших checkout.

Відкликання для всього репозиторію виконується явним `detent permissions revoke`. Воно спершу вимикає захищену registration, яку сервер перевіряє перед кожним review, потім прибирає тільки власні approve entries у зареєстрованих configs. Навіть при частковому записі configs disabled registration відхиляє наступні виклики. Вже запущений review може завершитися, що показується у результаті revoke. Повернення grant потребує нової явної згоди. Локальне native редагування одного config діє на його worktree й не заявляється репозиторним revoke.

Install, consent update, worktree inventory і revoke серіалізуються одним project writer lock для всіх version/digest. Review читає цілісний atomically published snapshot project state без writer lock, точкою допуску є отримання цього snapshot. Тому паралельні reviews не отримують install-locked через коротку конкуренцію. Допущений до atomic revoke запит може запуститися й завершитися після revoke, новий snapshot після disable забороняє допуск. Revoke показує cutoff revision й це обмеження. Offline configs лишаються в inventory із pending cleanup. Writer lock очікується до 5 секунд із явним busy результатом без grant. Stale lock не знімається лише за віком, recovery потребує підтвердженого завершення owner process або явної перевіреної repair-операції. Залишений writer lock не блокує читання останнього цілісного дозволеного snapshot.

## MCP-контракт і текстове рев'ю

Tool вхід містить явного `author: codex|claude|agy` та один варіант матеріалу.

```json
{"author":"codex","kind":"spec","path":"docs/specs/2026-11/design.md","revision":"HEAD"}
{"author":"codex","kind":"code","base":"main","head":"HEAD"}
```

Автор задається скілом як у чинному --author. Це declared provenance, автоматичне визначення фактичного авторства не стверджується. Невідомий author або неможливість підтвердити сімейство reviewer дають відмову. Поточні CLI flags і raw model overrides не стають tool arguments. Немає parameters для shell-команд, prompt, executable, registration/root, output path, permissions або arbitrary CLI flags. Schema відхиляє невідомі поля.

Для spec/code дозволено лише додатковий bounded `contextPaths` із repository-relative Git paths. Він передає контекст як untrusted blobs із того самого resolved review commit. Для spec автоматично додаються доступні committed constitution/spec-format/root-spec/package manifest/detent.json та project review guidance за чинними config keys. reviewContext і .detent/prompts/review-spec.md зберігаються як позначені untrusted guidance, без перетворення на privileged system instructions. Відсутність/небезпека reference або перевищення бюджету контексту дає явний coverage result/відмову, без тихого пропуску. Reviewer report має per-check verified/not-verified з evidence paths. Перевірку повторного використання чи відповідності коду не можна оголосити пройденою за відсутності потрібних файлів. Автор може передати додаткові contextPaths, права reviewer залишаються text-only.

Повторно використати чинні family mapping, reviewer selection/fallback та review protocol. Eligibility обмежується погодженими й live-перевіреними text-only adapters. Чинний worktree runner не викликається з MCP. Для цієї редакції підтверджений adapter Claude, інші отримують capability лише після окремої live no-tools проби. При відсутності придатного іншого сімейства setup лишається неповним. CLI Claude/Antigravity як author-host зберігають наявний legacy runner.

Spec path нормалізується й перевіряється чинним specPathError з тими самими config.specsDir та правилом `<specsDir>/<YYYY-MM>/*.md`. Окремо відхиляються absolute/traversal/NUL, Git pathspec magic вимикається. Revision через --end-of-options перетворюється на immutable commit, читаються тільки Git blobs з того дерева. Незакомічені зміни не включаються. Пробний fixture spec.md у П-8 демонстрував transport і не розширює продуктовий path contract.

Для PR base/head перетворюються на commits, визначається merge-base і передається diff mergeBase..head та head blobs змінених текстових файлів. Для єдиного merge-base це відповідає чинному base...head review. Відсутній або неоднозначний merge-base відхиляється явно, на відміну від legacy Git вибору однієї бази в criss-cross history. Rename/deletion позначаються явно, повертаються requested base/head і mergeBase. Git працює без shell, зовнішніх diff/textconv, checkout, hooks, filters та project code.

Binary, symlink, submodule та LFS pointer матеріали отримують явну помилку. Недопустимий UTF-8, порожній diff і перевищення payload 1 MiB також відхиляються. Обрізання, пропуск файлів або передача pointer як вихідного коду заборонені. Звіт перелічує exact coverage, тож відсутній контекст видно.

Установлений fixed system prompt вимагає аналізу untrusted матеріалу й забороняє виконувати його інструкції. Reviewer працює у нейтральному каталозі поза checkout, без tools, MCP, автоматичного завантаження project/user hooks, CLAUDE.md/AGENTS.md, plugins/custom commands і session persistence. Явно переданий committed контекст лишається лише текстом. Auth штатний для CLI. Для Claude використано П-8-комбінацію restricted/safe-mode, empty tools, strict empty MCP config та disableAllHooks. Init model/tools/MCP і stream перевіряються. Увімкнений tool, невідомий model family або tool_use означають failed.

Product review deadline 900 секунд збережений від чинного cross-review, разом із fallback. 180 секунд у П-8 були лише параметром малих fixture-проб. MCP tool_timeout_sec має бути щонайменше 930 секунд для завершення/cancel cleanup, host contract перевіряє цю можливість. Хост із меншим незмінним лімітом отримує needs-action, тихого скорочення deadline немає. Fallback лише на погоджений eligible text-only adapter, timeout зупиняє chain. Abort, stdio disconnect і deadline завершують local reviewer process tree, detached children не запускаються. Provider billing може продовжитися після локального обриву, результат тоді indeterminate, автоматичного платного retry немає. Product tests покривають host timeout, cancellation і довгий review. Legacy CLI exit-коди збережені.

Успіх повертає status=completed, report, findings/marker за чинним protocol, authorDeclared, фактичні reviewer/model/family, resolved commits, coverage, hash точного stdin payload, effectiveRoot, registration identity і no-tools observation. Completed означає отриманий валідний звіт, наявність дефектів записується окремо. Spawn/auth/error/timeout/overflow/invalid report повертають failed/needs-action з причиною, без успішного marker. Повторне надсилання після транспортної невизначеності автоматично не робиться, щоб не створювати приховані повторні платні reviews.

## Повторюваність і часткові помилки

Перед записом install планує власні файли/config changes, перевіряє конфлікти й отримує згоду. На одну registration застосовується exclusive lock. Нова package generation спершу повністю копіюється та перевіряється, публікується atomic registry update, потім configs переключаються на повний стан. Читачі мають бачити повну стару або повну нову generation.

Project config/state пишуться temp+rename в тому самому каталозі з перевіркою попереднього hash під lock. Перевірки canonical paths і symlink/reparse повторюються перед записом, реалізація не покладається лише на ранній lstat. Непідтримувана платформа без надійного захисту запису дає needs-action. File transaction для одного checkout відновлюється з журналу після переривання. Різні worktrees можуть лишитися на різних повних версіях. Частковий cross-root install не видає глобальний успіх, повтор продовжує лише незавершені кроки без автоматичного нового grant.

Конфлікт preflight дає exit 4 без застосування плану. Пізній IO failure записує фактичний partial state й дає неповний setup, зберігаючи попередні працездатні configs, де їх не замінено. Немає автоматичних recursive deletes, Git stash, checkout змін користувача чи cleanup старих копій.

--dry-run не пише, не бере locks, не запитує згоду, не запускає моделі й не витрачає ліміти. Runtime перевіряється без виконання project code. --help для CLI та підкоманд дає exit 0 без Git, мережі, записів і reviewer.

## Doctor і статуси

`detent doctor [--hosts ...] [--json]` виконує лише read-only перевірки. Версійований JSON має filesInstalled, runtimeVerified, permissionSetupComplete, selectedHosts і liveReviewVerified, а також конкретні причини needs-action. Для Claude-only runtime позначається not-required.

Configured означає native config з точним server identity/version/binding/approve. Verified-in-session означає фактичний tool call у конкретному host/session. Doctor без виклику MCP не може встановити другий статус. Installer не запускає модель для діагностики без охоплення цього використання scope згоди. Evidence містить host/version, package digest, project/root, config hash, reviewer/model, commits, результат та час. Зміни цих підстав скидають live-статус, credentials і повне env не зберігаються.

Setup exit 0 для обраного Codex означає доставлені файли, verified runtime/binding і підтверджену конфігурацію дозволів для підтриманого host contract. Live-review не є передумовою цього exit 0. Відсутність інструмента в уже відкритій сесії показує needs-refresh і точну інструкцію почати нову сесію, без повторної згоди.

Адаптер native proof читає свіжий effective config через підтриманий Codex app-server `config/read` із точним cwd та видимими layers/managed requirements, як у П-8. Версія, schema й surface звіряються з перевіреним support contract. Сам parse локального TOML, CLI --help чи config-only listing не достатні для permissionSetupComplete. Для Desktop адаптер має підтвердити, що proof endpoint відповідає налаштуванням саме цього Desktop-хоста. Якщо такий зв'язок не доведений, pending-перевірку може закрити native completed tool call у відповідній Desktop-сесії з ідентичністю встановленого server/binding. Стороння CLI snapshot не видається за Desktop proof. Unknown version, unreadable/stale effective state, managed override або відсутність потрібної native поверхні дають needs-action та exit 6 для обраного Codex. Межа configured/verified-in-session зберігається.

Usage exit 2, preflight conflict 4, незавершений setup 6. Permission skip/deny/unknown host policy для обраного Codex дає 6 із filesInstalled=true, якщо доставка завершена. Claude-only зберігає чинні exit-коди. Успішний dry-run дає 0 як план, без твердження про ready. Native managed deny має пріоритет. Detent не послаблює його й не підміняє повторним shell/npx запуском.

## Проби і докази

### П-1–П-7. Історія початкового дизайну

Попередні package/install/help/Claude/layout проби та їхні результати збережені в редакції @2ac0b26 цього файла й історії Д-1. Вони довели npx у текстах, відсутність permissions setup, необхідність окремої доставки скілів Claude та помилковість parent(common-dir) як checkout root. Невдала SEA-проба стосується лише того executable, а не запуску встановлених Node-модулів.

### П-8. Локальний MCP у CLI та Desktop

[Повний звіт](../../probes/2026-11/2026-11-09-cross-review-mcp.md), Windows, Node 26.12.1, Codex CLI 0.166.0, Claude Code 2.1.317. Код spike написали дешевші OpenAI-субагенти. У live-результатах reviewer claude-haiku-5-5, порожні tools/MCP і нуль tool_use. 18 focused тестів проходять.

Після однієї згоди власника CLI-сесії A й A-linked виконали spec/code reviews. Project config у worktree доставлено окремо. B не отримав інструмент, прямий старт сервера з cwd B відхилений. Injection не прочитала зовнішній синтетичний marker і не створила hook/MCP/launcher/write canaries. Заміна approve на prompt відхилила наступні CLI-виклики до reviewer.

Власник вручну повторив Desktop тести в A та A-linked й негативний B, підтвердив нуль запитів дозволу. Native list_projects/read_thread незалежно підтвердили roots, параметри та completed MCP calls без shell/npx. Desktop receipts з model/init не надавалися native summaries, ці поля для Desktop окремо не стверджуються.

Окремий CLI profile був лабораторним засобом ізоляції. Спроба завантажити звичайний user config була відхилена auto-review через сторонні інтеграції, її не повторювали. Desktop працював у звичайній сесії власника. Product installer UI, Desktop restart/revocation, Linux/macOS й додаткові reviewer adapters цими пробами не підтверджені.

### П-9. Захист config і виконуваного коду від sandbox-записів

Після зауваження К-1 виконано окрему беззаписну пробу в поточному native workspace-write sandbox. Node відкривав наявні файли лише з O_WRONLY, без записів і truncation, й порівнював SHA-256 до/після. Позитивний контроль README.md відкрився для запису. .codex/config.toml і зовнішній installed review-server.mjs отримали EPERM, хеші всіх трьох файлів не змінилися. Для exact config target тимчасово створено файл лише з коментарем, після перевірки SHA його прибрано. Settings/grants він не містив.

Результат у локальному `.superpowers/sdd/2026-11-09-cross-review-mcp-probe/evidence/active-write-boundary.json`. Поточний хост захищає власний project config і зовнішній код, як вимагає контракт. Окрема raw CLI sandbox-проба з :workspace завершилася до helper помилкою `registered Core process has no package identity`, це не доказ її файлових прав. Desktop/core і standalone CLI можуть мати різні backend/config contexts, тому адаптер не переносить native proof між ними автоматично. Для неперевірених surfaces діє needs-action gate.

Codex документує read-only .codex у вбудованому :workspace профілі. Документація підтверджує очікуваний контракт, локальна проба підтверджує лише фактичний поточний sandbox. [Офіційний контракт permission profiles](https://learn.chatgpt.com/docs/permissions).

## Заявка → доказ

| Заявка | Де записується | Що доводить | Сила |
| --- | --- | --- | --- |
| Скіли встановлено | filesInstalled, manifest | Точні файли, target і rendered blocks | Потребує product tests |
| Виконується pinned package | runtimeVerified | Захищений install path, інвентар і config identity | П-8 для spike, product acceptance обов'язкова |
| Захищені config і код | native boundary evidence | Write-handle позитивного контролю дозволено, config/installed-code EPERM, незмінні хеші | П-9 для поточного native host, інші surfaces потребують перевірки |
| Дозвіл налаштовано | permissionSetupComplete | Свіжий native effective config, binding enabled, host contract | П-8 CLI/ручний Desktop |
| Користувач погодив scope | protected registration | Інтерактивний user або trusted native write approval, hash лише для цілісності | У spike чатова згода й host-approved записи, product installer channel ще не перевірений |
| Згода працює між сесіями/worktrees | liveReviewVerified | Окремі completed tool calls і user prompt observation | П-8 CLI + Desktop |
| Інший repository виключено | binding validation | B config absence та runtime cwd rejection | П-8 |
| Reviewer іншого сімейства | review result | Declared author source + фактичний init model/family | П-8 OpenAI→Anthropic, інші adapter потребують проб |
| Reviewer без інструментів | no-tools observation | Init tools/MCP і stream tool_use + canaries | П-8 CLI chain |
| Матеріал відповідає запиту | commits/coverage/input hash | Immutable Git blobs, merge-base, точний stdin | П-8 для двох commits, merge-base product tests |
| Review завершений | completed/marker | Валідований звіт і успішний adapter result | П-8 |
| Grant відкликано для всього repo | revoke result | Disabled protected binding перед кожним викликом + configs | Новий product acceptance, spike перевірив лише native CLI prompt |
| Новий worktree має той самий scope | install result | Перевірка membership + unchanged grant + exact config | П-8 для одного linked, product tests для нових |

## Критерії приймання

1. У нових Codex CLI/Desktop сесіях видно всі чотири скіли. Spec і PR рев'ю проходять через MCP без bootstrap/npx та повторних MCP-погоджень після однієї install-згоди.
2. Погодження/відмова/skip/без-TTY/proposal apply перевірені через звичайний install entrypoint. Відмова не створює approve. Чужі TOML-дані, symlink paths, namespace collision та застарілий proposal не пошкоджуються.
3. Повторне встановлення, repair і recovery після переривання дають повний старий/новий runtime. Конкурентний install/revoke не залишає активного grant на непогоджений binding. Два version/digest в різних worktrees незалежні.
4. Новий linked worktree отримує config і скіли без нової згоди на той самий scope. Main/linked різних версій, main update, separate-git-dir, alias/reparse та moved/cloned roots мають явні перевірені результати.
5. Native downgrade/disable одного grant не відновлюється старим consent record. Repository revoke вимикає всі нові виклики, зокрема з worktree, який був offline. CLI/Desktop нові сесії й restart відображають відкликання.
6. Є фактичні no-tools проби reviewer для кожної підтриманої комбінації CLI/ОС. Невідомі model family, enabled tools, custom hooks/MCP, shell/preload substitution, invalid report, timeout/overflow/auth errors не дають completed.
7. Spec на old commit, PR із divergent base та merge-base, rename/delete, empty diff, unsafe paths, invalid UTF-8, binary/symlink/submodule/LFS, >1 MiB й injection не дають прихованого пропуску/виконання.
8. Doctor/help/dry-run не запускають моделі, не записують grant і не витрачають ліміти. Configured і verified-in-session розрізняються, stale evidence відкидається.
9. Claude plugin/.claude/CLAUDE.md та Antigravity .agents лишаються функціональними в нових сесіях із чинним scoped npx, без залежності від Codex runtime. Claude-only exit-коди, worktree/plugin update і чинні тести збережені. Shared .agents renderer перевірений для кожного author-host.
10. Для кожної заявленої підтриманої версії Codex CLI/Desktop повторені spec/code/B, відсутність додаткових prompts, restart/revoke. Неперевірена версія має needs-action, а не необґрунтований ready.
11. Немає persistent shell-prefix на project JS/Node/npx, глобальних MCP/rules, обходу managed deny чи імпорту writable runtime. Credentials використовує лише авторизована CLI. Повторні платні reviews після невизначеного transport state вимагають явного retry.

## Рев'ю спеки

Builder check завершено до коміту. За явним дорученням власника локально зібраний Detent запустив cross-review коміту 8a1d7c7 з чистого тимчасового checkout, без npx download і без --reviewer override. CLI обрав claude/default іншого сімейства. Exit 0, отримано 12 зауважень, усі розглянуто й виправлено нижче. Попередні маркери @f36e370 та Д-1 @e6ba55d лишаються історією інших редакцій. Після triage повторне рев'ю не запускалося.

| № | Перевірка | Рішення | Причина / що змінено |
| --- | --- | --- | --- |
| Б-1 | Спільний revoke/install lock і inventory configs | виправлено | Один project record для всіх версій, pending/active entries, atomic disable та визначена точка допуску review |
| Б-2 | Джерело effective permissions proof | виправлено | Свіжий native config/read, support contract і host identity, окремий Desktop proof, needs-action при невідомих підставах |
| К-1 | Writable project config | виправлено | П-9, config/package/state write boundary до grant, ignore як compatibility condition, невідома політика дає needs-action |
| К-2 | Git status і машинний config | виправлено | Локальний config і точний gitignore entry, tracked config дає conflict, legacy clean-tree acceptance |
| К-3 | Self-approval через apply/hash | виправлено | Hash лише цілісність, grant тільки через user/native protected write channel, немає approval прапорів |
| К-4 | Втрата контексту spec review | виправлено | Втрату розкрито власнику, committed references/reviewContext/guidance та contextPaths, per-check verified/not-verified |
| К-5 | Project-only store і fail-fast lock | виправлено | Окремий layout refactor, bounded writer lock/recovery, lock-free atomic snapshot admission |
| К-6 | Deadline і MCP timeout | виправлено | Product 900 s, MCP 930 s, cancellation і indeterminate transport, fixture 180 s не нормативні |
| К-7 | Повні великі head blobs | виправлено | Власнику явно зазначено сумарний 1 MiB, включно з whole head files і lockfile, без тихих exclusions |
| К-8 | Лабораторна область доказу | виправлено | Owner premise розділяє isolated CLI та owner-operated Desktop, нуль prompts зі слів власника |
| К-9 | Лише Claude text-only | виправлено | Dependency та втрата Codex agy fallback явно в owner section, інші adapters потребують проб |
| К-10 | Нові прапори названі чинними | виправлено | --hosts, --permissions та exit 6 явно нові, базові flags/Claude-only codes збережені |
| К-11 | Неоднозначний merge-base | виправлено | Звужено equivalence claim до unique merge-base, відмову при criss-cross розкрито |
| К-12 | Spec path format | виправлено | Повторне використання чинного specsDir/YYYY-MM validator, приклад виправлено |
