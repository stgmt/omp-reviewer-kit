---
name: mutation-fast-default
description: Перед mutation gate применять пользовательский стандарт: 4 async workers, verified worker-tree reuse и calibrated точные selectors; при несовместимом runner спросить о переделке, если её ещё не разрешили.
---

# Быстрые мутации по умолчанию

Полная общая методика установлена в `~/.claude/skills/mutation-fast-default/SKILL.md`. Прочитать её до запуска, изменения или планирования mutation gate. Если skill не рекламируется текущей сессией, читать файл напрямую, не вызывать несуществующий Skill/tool.

## Стандарт

- Четыре async workers; один мутант в одной независимой copied tree. Native framework предпочтительнее собственного scheduler, если уже обеспечивает гарантии.
- Timing/process-tree jobs — exclusive после drain всех обычных jobs.
- Одна копия проекта на worker. Перед reuse проверить pristine files/paths/modes/links; восстановить все test side effects, очистить owned scratch и дождаться завершения дочерних процессов. Contaminated worker изъять/rebuild.
- Точные selectors разрешены только с baseline PASS, реально исполненными ожидаемыми leaf tests, доказанным deciding assertion failure на мутанте и сравнением с full-suite reference на одном input.
- Все исходные mutant IDs сохраняются. Nonzero, timeout, import/spawn/syntax/harness error, ноль selected tests и cleanup failure не считаются killed.
- Если runner этому не соответствует и переделка ещё не разрешена, спросить до долгого legacy run: «Рекомендую переделать mutation gate на 4 workers, чистые worker-копии и доказанные selectors. Переделать?» Назвать конкретный пробел. При уже явном разрешении не спрашивать снова; при выборе legacy режима выполнить его честно.
- Не менять active release index, не перезапускать текущий gate автоматически, не переносить green results на изменённые bytes. Модели, hooks и credentials не обходить.

## План данного проекта

[Анализ и полный план](../../../audit-reports/mutation-acceleration-plan-2026-10-13.md).

Рабочая реализация использует pool/reuse/selectors; полная приёмка и релиз отмечаются отдельно в [статусе проверки](../../../audit-reports/mutation-acceleration-status-2026-10-13.md). Development gate требует Node 22+ для точного native nested selection; plugin runtime сохраняет Node 18+. Наличие скилла не доказывает зелёный полный каталог или ускорение.
