---
project: azkar
public: true
type: design
audience: users
title: Точная настройка шрифта Amiri
summary: Арабский текст на экране чтения приведён к настройкам официального публичного экрана neezam для Amiri.
user_impact:
  - Лигатуры и расстояния между арабскими символами формируются настройками Amiri без принудительного кернинга.
  - Шрифт остаётся доступным офлайн в приложении.
screenshots: []
checks:
  - Сверка CSS публичного экрана neezam: Amiri, 400, font-feature-settings: normal.
  - Ручная проверка экрана чтения: AzkarAmiri, 400, font-feature-settings: normal, font-kerning: auto.
  - git diff --check
deploy_url: http://127.0.0.1:3010/app/
---

Notes for editor:
- What changed: Убраны принудительные font-feature-settings и font-kerning с арабского текста.
- Where to verify: Любая карточка утренних или вечерних поминаний с выбранным Amiri.
- Risks: Низкий; затронуты только OpenType-настройки арабской типографики.
