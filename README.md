# dsh-plugin-opencode-session-header

Плагин DeepSeek Harness: отправляет обязательный заголовок `x-opencode-session`
на маршрутах OpenCode и OpenCode Go (`opencode.ai/zen`, `opencode.ai/zen/go`).

Без него шлюз отвечает `400 MissingSessionID`: `dsh-llm-pi-ai` передаёт id сессии
в pi-ai как опцию стрима, а pi-ai превращает её в другие заголовки
(`session_id`, `x-client-request-id`, `x-session-affinity`, `x-session-id`),
но не в `x-opencode-session`.

## Что делает

Плагин подменяет обёрткой коллекцию моделей уже зарегистрированного pi-ai-адаптера
(`Models.streamSimple()`), добавляя в опции запроса
`x-opencode-session: <id сессии>` — ровно для маршрутов OpenCode и только когда
в запросе есть id сессии. На границе pi-ai в этот момент уже есть обе половины:
адаптер получает id сессии от agent loop и передаёт его вместе с заголовками
развёртывания.

- Маршрут считается OpenCode, если id провайдера начинается с `opencode` или
  endpoint содержит `opencode.ai` (второе покрывает alias-ключи).
- Запрос без id сессии и любой другой маршрут проходят без изменений.
- Динамический заголовок перекрывает одноимённый статический из профиля
  (регистр не важен): фиксированное значение не выражает идентичность разговора.
- Ничего не меняет в конфигурации `llm-pi-ai`, не требует сборки и не имеет
  зависимостей.
- Обёртки снимаются при выгрузке плагина: отключение записи возвращает адаптер
  в исходное состояние без перезапуска.

## Установка

Пакет объявляет `dsh.bundle`, поэтому он ставится и управляется как бандл — через
страницу **Plugins** в Web UI или командой:

```sh
dsh plugin --profile web add git+https://github.com/Shiccah/dsh-opencode-session-header.git
```

Патч бандла сам вставляет запись `opencode-session-header` в композицию профиля:
**править YAML не нужно**, и вручную добавлять такую же запись нельзя — две строки
с одним id смонтируют плагин дважды.

Локально, из клона или рабочего каталога:

```sh
git clone git@github.com:Shiccah/dsh-opencode-session-header.git
dsh plugin --profile web add ./dsh-opencode-session-header
```

Вариант без установки: загрузчик принимает абсолютный путь к файлу, тогда пакет
в профиль не добавляется вообще (проверено на живой композиции):

```yaml
- insert:
    - id: opencode-session-header
      name: "/абсолютный/путь/к/dsh-opencode-session-header/index.js"
```

Проверить состав дерева без запуска:

```sh
dsh --profile web --dump-config | grep -A 3 opencode-session-header
```

Запись должна быть ровно одна. Отключить плагин, не удаляя пакет, можно на той же
странице **Plugins** (или `dsh plugin --profile web remove
dsh-plugin-opencode-session-header` для полного удаления).

Профиль `web` подхватывает правки patch-слоя на лету (`patchReload: live`),
поэтому запись монтируется в уже запущенный процесс; если в логе появилось
`failed to import` — пакет не резолвится из каталога профиля, перезапустите
`dsh web` после установки.

## Конфигурация (необязательно)

| Поле | По умолчанию | Значение |
|---|---|---|
| `header` | `x-opencode-session` | Имя заголовка. |
| `hosts` | `['opencode.ai']` | Фрагменты endpoint, по которым маршрут считается OpenCode. |
| `providerPrefixes` | `['opencode']` | Префиксы id провайдера, по которым маршрут считается OpenCode. |

Некорректное значение поля плагин отвергает при загрузке с `TypeError`.

## Как это ломается и что делать

Плагин опирается на три внутренние точки `dsh-llm-pi-ai`/pi-ai:

1. `ctx.llm.adapters` — карта зарегистрированных адаптеров;
2. метод `current()` адаптера, возвращающий снимок с полем `models`;
3. `models.streamSimple(model, context, options)` — вызов pi-ai, в опции которого
   плагин и добавляет заголовок.

Если в новой версии DSH этих точек не станет, плагин не станет работать молча:

- пропала карта адаптеров — падение при загрузке с текстом
  `ctx.llm.adapters is not a Map`;
- у pi-ai-адаптера нет коллекции моделей — предупреждение
  `a pi-ai adapter exposes no model collection with streamSimple()` в логе.

В обоих случаях правка одна — обновить селекторы в `index.js` (`wrapAdapter`,
`injectIntoModels`). Правка того же поведения в самом `dsh-llm-pi-ai`
(см. Agent Note `2026-09-07-opencode-go-session-header` в репозитории
deepseek-harness) снимает нужду в плагине совсем.

## Проверка

```sh
node --test test/*.test.js
```
