# Проверка Vercel skills

Дата: 2026-11-07. Проверена версия `skills` 1.7.6 через `DO_NOT_TRACK=1 pnpm dlx skills --version`. До запуска `codex-doctor collect --dry-run` выполнен отдельно. Тесты ниже выполнены на macOS в одноразовых каталогах с искусственным навыком; глобальная установка не использовалась. SHA-256 действующего `~/.agents/.skill-lock.json` до и после проверок совпал. Это не проверка приватного Git или всех платформ.

## Локальный Git и lock

Создан одноразовый Git-репозиторий с `SKILL.md` и `resource.txt`, затем он подключён локальным Git-подмодулем `vendor/source` в пустом тестовом проекте. Команды (`$CLI` обозначает исполняемый файл `skills` 1.7.6 из кеша pnpm):

```sh
git -c protocol.file.allow=always submodule add "$SOURCE" vendor/source
DO_NOT_TRACK=1 "$CLI" add "$PROJECT/vendor/source" --agent codex cursor --skill fixture-provenance --yes
DO_NOT_TRACK=1 "$CLI" list --json
DO_NOT_TRACK=1 "$CLI" update fixture-provenance --project --yes
```

`add` завершился с кодом 0 и скопировал оба файла в `.agents/skills/fixture-provenance`; это не ссылка на подмодуль. Проектный `skills-lock.json` версии 1 записал `source: "./vendor/source"`, `sourceType: "local"` и `computedHash`, без Git-коммита. `list --json` показал установку как `tracked` и источник как local. `update` завершился с кодом 0, но сообщил `No installed skills found matching: fixture-provenance`: код выхода не подтверждает обновление. Реальный глобальный lock версии 3 не изменялся.

## Ссылки и копии

С искусственным локальным источником `source/skills/fixture/SKILL.md` команда

```sh
DO_NOT_TRACK=1 "$CLI" add "$SOURCE" --agent codex claude-code --skill fixture-provenance --yes
```

скопировала навык в `.agents/skills/fixture-provenance` и создала ссылку `.claude/skills/fixture-provenance -> ../../.agents/skills/fixture-provenance`. Ссылка указывает на копию CLI, а не на Git-источник. В другом тестовом проекте `--copy` создал обычные файлы `SKILL.md` и `resource.txt` в `.claude/skills/fixture-provenance` и записал `installMode: "copy"` в project lock. При установке одного Claude Code без `--copy` CLI также создал копию; поведение зависит от выбранных платформ.

## Границы

Наличие CLI само по себе не выполняет контракт SkillBuddy: доказаны локальное чтение, копирование, ссылка между платформенными каталогами и запись проектного lock, но не ссылка на управляемый Git-подмодуль или обновление локального источника. Помощь `skills --help` не перечисляет команды Git diff и merge. Git-конфликты, сохранение локальных изменений, приватный Git, работа с архивами и навыками плагинов, глобальные операции и другие ОС в этом эксперименте не проверены. Не следует менять семантику существующего глобального lock на основании этих результатов.
