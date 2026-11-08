# Миграция отдельных навыков

Дата: 2026-11-08. Перенесены четыре установки из `~/.agents/skills` и совпадающая отдельная установка `make-interfaces-feel-better` из `~/.codex/skills`.

| Навык | Upstream | Управляемый commit |
| --- | --- | --- |
| `make-interfaces-feel-better` | `jakubkrehel/make-interfaces-feel-better` | `4df78adb6bd74c5464028d4850b40ac85477de11` |
| `styleseed-design-review` | `bitjaru/styleseed` | `5cd02fc13a34a03dcdb62f6508ae2d87b4f515af` |
| `design-style` | `wangqi422/design-style-skill` | `ca6dbf0b90f252fa5b7030350e1ca771b5b07339` |
| `self-learning` | `kulaxyz/self-learning-skills` | `d4e0a7ec1f1ae1b5c7f7972b52ad8ed0c2c067ae` |

Для первых, второго и четвёртого навыков установленные файлы совпали с деревьями, указанными в lock. Для `design-style` commit из lock содержит тот же установленный `SKILL.md`; поскольку навык находится в корне репозитория, установленный набор отдельно сохранён поверх исходного commit `4a74434c34da221cac4a43bb2585e2a591326106`. Исторические коммиты установки не установлены.

GitHub показывает MIT для четырёх текущих upstream. У совпавшей ревизии `make-interfaces-feel-better` отдельный файл лицензии отсутствует; это ограничение сохранено в metadata. В остальных трёх базовых ревизиях есть MIT LICENSE. Actions отключён до публикации каждой копии.

Оригиналы, hashes, пути и снимки сканирования находятся в `~/.codex/backups/skill-provenance/individual-skills-CCfPsgHK`. До и после переключения сканер обнаружил по девять записей с одинаковыми платформой, областью, путём, типом расположения и состоянием включения; отдельно осталось шесть ошибок чтения отсутствующих корней. Содержимое и режимы сверены со снимком.

Четыре дочерних commit опубликованы и прочитаны повторно до родительского `d7dee36bbebaca429a00fdc6d6cc3f9066ad5867` в `Stepan5024/codex-harness`; удалённый `main` прочитан на той же ревизии. Доступ к приватным копиям проверен под `adapstory`; доступ под `Stepan5024` отдельно не подтверждён. Старый lock не изменён.
