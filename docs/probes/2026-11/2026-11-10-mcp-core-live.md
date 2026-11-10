# MCP-ядро: installed CLI і live Claude

Дата: 2026-11-10. Це перевірка ядра перед installer/harness, не доказ готового встановлення чи native grant.

## Середовище й scope

Windows, Node v26.12.1, Claude Code 2.1.317. Власник явно дозволив committed специфікації, PR-код і контекст Detent через Claude/Anthropic, включно з повторними рев’ю та витратами ліміту. Провайдер у цих пробах — лише Anthropic; fallback не використовувався.

`npm run smoke` зібрав npm-архів і встановив його в окремий temporary consumer. `scripts/smoke-mcp-live.mjs` запустив справжній встановлений `dist/cli.js mcp --registration …` абсолютним Node, з cwd перевіреного linked checkout. Тимчасовий fixture registration містив явні main/common paths, pinned version/digest і native Claude executable. Fake runner, compiler fixture та публічний production override не застосовувалися.

Клієнт тримав stdin відкритим, виконав initialize/initialized/tools-list та справжні `tools/call`. Успіх перевірявся за completed, фактичним model/family, порожніми tools/MCP, root, commits, package identity і однаковим provenance у structured та стандартному text receipt. Findings можуть бути ненульовими: completed означає отриманий валідний звіт.

## Фактичні результати

| Матеріал / збірка | Результат |
| --- | --- |
| Spec на `57cdb21` | Completed, `claude-haiku-5-5`, 4 findings; tools/MCP порожні, toolUseCount 0. Точний stdin hash `5ff88e46866c6c69efe7f77ae09aeea1d1e73e8ae4d2b5ad2e731da10f043c91` |
| Повний code range до `57cdb21`, близько 738 КБ | Failed: invalid/duplicate CHECK evidence. Успішного marker не обчислено |
| Spec на `2d32de2`, explicit-mode prompt | Completed, `claude-haiku-5-5`, 11 findings; ті самі no-tools спостереження |
| Повний code range до `2d32de2` | Failed: немає фінального CROSS-REVIEW-RESULT. Успішного marker не обчислено |
| Code-only `57cdb21..dfa1bc2`, менший реальний range цієї гілки | Completed, `claude-haiku-5-5`, 3 findings; tools/MCP порожні, toolUseCount 0; base/mergeBase/head, effective root і legacy receipt збігаються |

Останній code receipt має stdin hash `8f2bb9dfde49f11f2b48aa4252e84ca151ae62669e0a192425e161b44cf83009` та runtime digest `449ed874b3319b05069a7515453f24cfb45e7b1f388b183aabed2214da287adb` для package version 0.5.0. Spec і code успіхи отримані на різних позначених збірках; це не один фінальний combined run. Подальша мала зміна зачіпає лише Unicode-tail діагностики відмови й test expectations; successful review path не змінювався.

Автоматичних повторів не було. Після першої відмови виправлено підтверджену неоднозначність trusted prompt: активний режим і лише його required checks тепер явні. Точний попередній неправильний рядок невідомий: старий guard не зберігав відхилений report. Після другої відмови bounded diagnostics поширено на final-count помилки. Остання проба була явно code-only й не повторювала вже завершені spec-запити.

Дві великі code-проби **не доводять** надійності форматування великого payload у Haiku. Backend відмовив без false completed і без автоматичного платного retry. Менший code range підтверджує normal installed CLI success path, а не успіх великого range. Ліміт payload 1 MiB не є гарантією успішної відповіді провайдера.

## Triage додаткових live-звітів

Ці звіти були acceptance-матеріалом; вони не замінюють первинний cross-review всього PR.

- Перший spec-report: усунено застарілий текст про очікування вже наданого approval; скорочено owner summary без зміни погоджених рішень/L; явно описано fixed guidance paths; посилено точні test assertions.
- Другий spec-report: повернуто до owner summary короткий breakdown/дешевшу альтернативу, чинне Windows-обмеження та незворотність передачі провайдеру/витраченого ліміту. Уточнено host-escalated створення P-9 target і межі цієї проби. Зміна оцінки L без нових вимог відхилена; відсутні у coverage server/tests/probe не є відсутнім enforcement. Заявлений spawn race не підтверджено: класифікація виконується після cleanup/close, а локальна Node-проба дала spawn до close. Вимогу generic refactor коротких різних wrappers відхилено: спільні Git environment/process helpers уже використовуються.
- Успішний code-report: вимогу нового approval відхилено — мета, ключові рішення та L збережені, факт попередньої згоди є в діалозі, якого text-only reviewer не отримував. Умовне обчислення очікувань перенесено в явні рядки test table. Tail діагностики зроблено Unicode codepoint-safe з незалежним emoji boundary-тестом.

## Відтворення й межі доказу

Ручний harness запускається тільки явно: `node scripts/smoke-mcp-live.mjs <scenario.json>`. Scenario задає абсолютні package/repo/main/common/Git/Claude paths, immutable base/head, spec, contextPaths і outputDir. `modes` можна пропустити для обох режимів або явно задати `["code"]`/`["spec"]`; null, порожні, дубльовані й невідомі режими відхиляються до запуску. Виклики витрачають account limits. Evidence зберігається до model call, після кожного результату й при відмові; повторів harness не виконує.

Повні приватні receipts/reports залишені в `.superpowers/sdd/2026-11-09-mcp-review-core/` у каталогах `live-normal-cli`, `live-mode-specific`, `live-code-slice`; абсолютні machine paths тут не публікуються. Тимчасові consumer/state каталоги збережені. Environment, credentials і raw stdin в evidence не записуються.

Fixture registration не встановлює native Codex config і не є installer consent або доказом захищеного state. Ця проба не перевіряє product delivery скілів, ефективний native host grant, Desktop refresh/revoke, майбутні worktrees чи doctor. Для них потрібний наступний harness-план і окремі acceptance checks. Package не публікувався й PR не merge-ився.
