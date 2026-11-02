# План: публікація як `@ysilvestrov/detent` і безпечна команда в правилах

Спека: [2026-11-02-npm-scoped-package-design.md](../../specs/2026-11/2026-11-02-npm-scoped-package-design.md).
Виконання: `dispatch` для всіх задач, бо кожна чіпає більше двох файлів або не має в плані повного
тексту. Один PR, рефакторингу окремо немає, три задачі. Гейт кожної задачі: `npm run gate`.

## Загальні обмеження

- Команда в правилах: `npx -y @ysilvestrov/detent …`. Бінарник лишається `detent`.
- Версія `0.3.0` у `package.json`, `package-lock.json` і `.claude-plugin/plugin.json`.
- Ім'я плагіна `detent` і версія маркера `v1` не змінюються.
- Історичні спеки й плани не правимо.
- Публікацію виконує власник; агент не запускає `npm publish`.

## На що дивитися на рев'ю

1. Агент виконує скіл у самому репо detent: нова форма там падає (П-5), тож `reviewContext` має
   прямо назвати `npx detent` і `node dist/cli.js`.
2. Свіжий clone без збірки: `dist/` немає, поки не пройшов gate. Покриває `gate` у `detent.json`.
3. Блок із нинішнім маркером і записом у маніфесті має оновитися, а не дати конфлікт. Закріплює
   тест задачі 1.
4. Проєкт на npm 12 із git-залежністю: `npm ci` падає ще до `install`, тож у README перехід
   починається із заміни залежності.
5. Проєкт без `package.json`: форма зі скоупом має працювати. Перевіряє крок 4 випуску
   (`install` у чистому репо без `package.json`).

## Задача 1. Команда в правилах

Файли: `constitution/constitution.md`, `src/install/blocks.ts`, `skills/cross-review/SKILL.md`,
`skills/design-spec/SKILL.md`, `skills/design-spec/spec-format.md`, `skills/dev-cycle/SKILL.md`;
тести `src/content.test.ts`, `src/install/blocks.test.ts`, `src/install/plan.test.ts`,
`src/commands/install.test.ts`.

1. Тести спершу:
   - `src/content.test.ts`, новий: жоден файл у `skills/` і `constitution/` не містить `npx detent`;
   - `src/content.test.ts`, наявний: `^npx -y @ysilvestrov/detent cross-review .*$`, ті самі два рядки
     з вирівняними коментарями;
   - `B` і `BEGIN` у трьох тестових файлах містять `` `npx -y @ysilvestrov/detent install` ``;
   - `src/commands/install.test.ts`, новий: блок зі старим маркером (`` `npx detent install` ``) і
     записом у маніфесті після `install` має новий маркер, а текст поза маркерами лишається як був.
     Запис маніфесту для цього блоку отримати через той самий шлях, яким його пише `install`.
   Переконатися, що падають.
2. Замінити текст у всіх файлах вище, разом із `description` у `skills/cross-review/SKILL.md`.
3. Гейт, коміт.

## Задача 2. Пакет і власний репо

Файли: `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `detent.json`.

1. `package.json`: `name` `@ysilvestrov/detent`, `version` `0.3.0`,
   `repository` `{ "type": "git", "url": "git+https://github.com/ysilvestrov/detent.git" }`,
   `publishConfig` `{ "access": "public" }`, скрипт `prepare` замінити на `"prepack": "npm run build"`.
2. `.claude-plugin/plugin.json`: `version` `0.3.0`. Оновити lock через `npm install --package-lock-only`.
3. `detent.json`: додати `"gate": "npm run gate"`; у `reviewContext` дописати, що в цьому репо скіли
   кажуть форму зі скоупом, а запускати треба `npx detent` або `node dist/cli.js`.
4. Перевірка: чистий clone гілки, `npm ci`, `npm run gate`, `npx detent --version` → `0.3.0`;
   `npm pack`, потім установка тарболу в чистий проєкт на npm 12.2.1, `npx -y @ysilvestrov/detent --version`
   → `0.3.0`. Записати, чи є попередження `install-scripts`; це потрібно для задачі 3.
5. Гейт, коміт.

## Задача 3. README

Файл: `README.md`.

1. Розділ установки: `npm i -D @ysilvestrov/detent`; одноразово `npx -y @ysilvestrov/detent install`.
   Прибрати «installed from git only» і абзац про `prepare`.
2. Рядки 83, 120, 150: нова форма. Рядки про `install-scripts` і Install from git у розділі обмежень:
   прибрати git-установку; `install-scripts` прибрати, лише якщо задача 2 показала, що попередження
   зникло.
3. Новий підрозділ про перехід зі старої установки: заміна git-залежності (`npm rm detent`, потім
   `npm i -D @ysilvestrov/detent`), запуск `install`, конфлікт для зміненого блоку або блоку без запису
   в маніфесті (нічого не пише, полагодити руками).
4. До обмежень: скіли плагіна Claude оновлюються разом із плагіном, а не через `install`.
5. Новий розділ для власника про випуск: тег, чистий checkout, `npm publish` із 2FA, перевірка
   `npm view @ysilvestrov/detent version dist.shasum`, перевірка в порожній теці й у теці із
   залежністю на npm 11 і 12.
6. Гейт, коміт.

## Перед PR

Cross-review гілки за скілом `detent-cross-review`, запуск через `npx detent`. Тег, публікація,
перевірка з реєстру й оновлення плагіна йдуть після мерджа, порядок у спеці; реальний розмір
дописати в «Оцінка» після них.
