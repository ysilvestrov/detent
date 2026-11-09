# Ядро локального MCP cross-review — план реалізації

> Виконання через superpowers:subagent-driven-development. Код ізольованих компонентів пишуть gpt-6-luna субагенти, інтеграція й перевірка залишаються в цій сесії. Після чотирьох завдань потрібне наскрізне рев'ю ядра, потім окремий harness-план.

**Мета.** Реалізувати перевірений stdio MCP entrypoint, який читає погоджену проєктну прив'язку і проводить text-only рев'ю committed матеріалів іншою родиною моделей.

**Архітектура.** Чотири модулі відділяють atomic registration admission, Git payload, асинхронний no-tools Claude adapter і MCP protocol. Використовуються наявні runtime codecs, config parser, family mapping та review marker protocol. Інсталятор і writer transactions додаються наступним планом.

**Стек.** TypeScript, Node >=20, стандартні fs/crypto/child_process/readline, Vitest. Пакет лишається без runtime dependencies.

**Специфікація.** docs/specs/2026-11/2026-11-09-install-readiness-design.md, затвердження продовженням власника після ba0f152. Д-1 історична. Наявні src/runtime/contract.ts і store.ts з попереднього плану залишаються базою для подальшого окремого layout refactor.

## Загальні обмеження

- Declared author codex/claude/agy перевіряється чинним family mapping. Перший eligible text-only reviewer Claude. Tool не приймає executable/model/permissions/root/prompt overrides.
- Runtime/grant installation та native boundary proof поки не реалізуються. Ручна fixture registration у тесті не є user consent або ready setup.
- Registration читається наново на кожний виклик. Disabled registration відхиляється до Git payload/reviewer. Reader не використовує fail-fast writer lock.
- Git і reviewer запускаються абсолютними executable, shell=false. Проєктні instructions є untrusted data. Тести не виконують справжній платний review.
- Payload 1 MiB UTF-8, output 1 MiB, review deadline 900 секунд. Cancel/disconnect завершує local reviewer tree, без automatic retry.
- Spec path перевіряється чинним specsDir/YYYY-MM validator. PR використовує єдиний merge-base і повні head text blobs.
- Існуючі CLI install/cross-review/pr-review і Claude/Antigravity paths мають пройти gate з чинними очікуваннями.
- Temporary fixture dirs залишаються для відтворення. Recursive cleanup не додається.

## Файли й спільні контракти

Створити src/mcp/registration.ts, input.ts, claude.ts, server.ts та відповідні *.test.ts. Оновити src/cli.ts і CLI tests тільки в завданні 4. Кожний модуль визначає власні експортовані типи, описані нижче. Зміни інших файлів потребують узгодження інтегратором для запобігання паралельним конфліктам.

Registration schemaVersion=1. ProjectRegistration має projectId, revision, enabled, mainRoot, gitCommonDir, gitExecutable, capabilities і worktrees. Capability має version, digest та reviewers. Reviewer має id="claude", executable і optional model. Worktree має root, configPath, version, digest, state="pending"|"active". Paths абсолютні, configPath рівно root/.codex/config.toml. Невідомі поля й duplicate/conflicting entries відхиляються. Version/digest відповідають runtime contract формату.

RuntimeIdentity = {version:string,digest:string}. Admission = {registration:ProjectRegistration, capability:Capability, root:string, gitExecutable:string}. Reader приймає registrationPath, current cwd та RuntimeIdentity. Git metadata identity і registered worktree membership перевіряються через pinned Git. Повний writer/recovery API у цьому плані відсутній.

ReviewRequest = {author:ReviewerId,kind:"spec",path:string,revision:string,contextPaths?:string[]} або {author:ReviewerId,kind:"code",base:string,head:string,contextPaths?:string[]}. Невідомі поля відхиляються. PreparedReview має mode, author, commits={head,base?,mergeBase?}, coverage=[{path,status:"included"|"missing",role}], text, inputSha256. Exact stdin body є text, system prompt передається окремим fixed CLI argument.

ClaudeReviewResult має report, findings, model, tools:[], mcpServers:[], toolUseCount:0. Це дані валідації реального init/stream, а не константи, підставлені після exit 0. Marker обчислюється через наявні successBody/markerLine, count через classifyResult.

## Фокус рев'ю

1. Revocation snapshot, package version і context root не можуть змішуватися між паралельними запитами — завдання 1 і 4.
2. Зовнішні paths, symlink blobs, Git env/config або executable lookup не можуть виконати project code — завдання 1–3.
3. Контекст і великий lockfile не відкидаються мовчки заради бюджету — завдання 2.
4. Псевдо-success, неправильний model, enabled tools, timeout і transport abort не дають успішного marker — завдання 3–4.
5. Вхід MCP відрізняє notifications, request IDs, invalid arguments і cancel без stdout contamination — завдання 4.

## Завдання 1. Валідований registration snapshot і Git admission

Файли src/mcp/registration.ts та registration.test.ts.

Інтерфейси parseRegistration(value:unknown):ProjectRegistration і readAdmission(registrationPath:string,cwd:string,identity:RuntimeIdentity):Admission. Source path не може бути symlink/hardlink або лежати всередині зареєстрованих worktrees. Executable paths абсолютні й поза worktrees, pending/disabled/unknown version/digest не допускаються. Це structural checks, filesystem protection підтвердить installer.

- [ ] RED. Тести admission main/linked, B refusal, exact cwd root, malformed/extra keys, pending/disabled, version/digest mismatch, changed common-dir, relative executable і linked registration file. Fixture repos нові на кожний test run.
- [ ] GREEN. Reuse safeComponent/contract conventions без дублювання великого runtime validator. Sanitized Git environment, shell=false, canonical identity та Git worktree list з незалежним main root.
- [ ] Re-read registration після disable і довести відмову без кешу. Дві одночасні read admissions не потребують writer lock.
- [ ] npm test -- src/mcp/registration.test.ts, typecheck, task review, commit.

## Завдання 2. Committed payload і контекст

Файли src/mcp/input.ts та input.test.ts. Незалежне від admission I/O, викликається тільки після admission.

Інтерфейси parseReviewRequest(value:unknown):ReviewRequest та prepareReview(root:string,gitExecutable:string,request:ReviewRequest):PreparedReview. Config parser і specPathError існуючі. Safe Git reader не виконує checkout/status/hooks/filters, відкидає inherited GIT_* overrides.

- [ ] RED. Специфікація на old commit, committed context, missing optional references у coverage, missing explicit context path як помилка, unknown fields, unsafe paths/revs, symlink/submodule/binary/LFS/invalid UTF-8, payload >1 MiB.
- [ ] RED. Code із divergent base має exact merge-base/head blobs, rename/delete позначені, empty diff і ambiguous merge-base відхилені. Uncommitted canary не потрапляє до stdin.
- [ ] GREEN. Resolved commit IDs, --literal-pathspecs/--end-of-options, no-ext-diff/no-textconv, deterministic text та SHA256. Автоконтекст з чинних config keys і відомих committed reference files, reviewContext/project guidance як untrusted data. Немає мовчазного truncation.
- [ ] npm test -- src/mcp/input.test.ts, typecheck, task review, commit.

## Завдання 3. Claude text-only transport

Файли src/mcp/claude.ts та claude.test.ts. Використовує Reviewer shape з registration та protocol.classifyResult.

Інтерфейс runClaudeReview(options:{reviewer, text:string, cwd:string, signal?:AbortSignal, timeoutMs?:number, maxOutputBytes?:number}):Promise<ClaudeReviewResult>. Тести можуть ін'єктувати spawn/process-tree cleanup через internal I/O option, недоступний через MCP parameters.

- [ ] RED. Fake CLI записує stdin/args і повертає init + report/result JSONL. Assertions фіксують absolute command, empty tools/MCP, safe/restricted/settings/system-prompt, nonzero/empty/malformed, wrong family, enabled tools/tool_use, invalid terminal marker.
- [ ] RED. Timeout, already-aborted signal, active cancellation, output overflow і disconnect cleanup не залишають running child й не повертають completed. Визначити cleanup direct child/tree для підтриманих платформ, unsupported host не отримує хибного proof.
- [ ] GREEN. Async spawn без shell, environment sanitization, exact input/output limits, fixed no-tools prompt, observed init validation й reuse classifyResult. Не використовувати legacy process.execPath як Node для чужої npm shim. Для початкового supported Windows native Claude executable npm shim може мати явний needs-action до окремої підтримки.
- [ ] npm test -- src/mcp/claude.test.ts, typecheck, task review, commit.

## Завдання 4. MCP server і звичайний CLI entrypoint

Файли src/mcp/server.ts, server.test.ts, src/cli.ts і його тести. Споживає API завдань 1–3. Public entrypoint detent mcp --registration <absolute-path>. Package identity виводиться з установленого package snapshot, не береться з tool arguments. Сервер не створює grants.

- [ ] RED. Actual stdio subprocess initialize/initialized/ping/tools-list/spec+code call, unknown tool/arguments, invalid JSON/request, notifications без відповіді, stdout лише JSON-RPC. Paid runner у тестах fake, normal entrypoint перевіряється real subprocess.
- [ ] RED. Disabled state після першого запиту, unregistered cwd, wrong author family, simultaneous requests, cancellation notification та stdin-close дають точні результати. Errors не створюють completed/marker, successful receipt має observed model/family/commits/hash/coverage/root/project revision.
- [ ] GREEN. Один cross_review tool, fixed config, per-call admission, prepareReview і runClaudeReview. Відповідь містить структурований result і текстовий report. Request cancel/disconnect керує AbortController, process tree cleanup з task 3.
- [ ] --help верхнього CLI та mcp дає 0 без filesystem/Git/reviewer side effects, чинні subcommands зберігають очікування тестів.
- [ ] npm run gate, npm run smoke. Наскрізний fresh review ядра, commit виправлень. Потім написати harness-план на основі фактичних API.

## Межа завершення ядра

Готовий і перевірений MCP entrypoint ще не означає готовий install. Після whole-core review наступний план покриває захищений package layout і writer transactions, native proposals/permissions, installer/doctor/renderer, host compatibility/live acceptance. Спочатку like-for-like layout refactor окремим PR, поведінкові зміни поверх нього за специфікацією. Публікація пакета й merge виконуються лише власником.
