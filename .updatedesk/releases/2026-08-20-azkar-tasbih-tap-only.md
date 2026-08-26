---
project: azkar
public: true
type: fix
audience: users
title: Счётчик-тасбих теперь считает только по тапу
summary: Убрали жест потягивания счётчика-тасбих, оставив только лёгкий тап. Теперь при касании счётчика страница скроллится естественно без случайных срабатываний.
user_impact:
  - Счётчик больше не перехватывает вертикальный скролл страницы.
  - Тап увеличивает счётчик на 1 с сохранением тактильного отклика (гаптика) и анимации нажатия.
  - Подсказка для новых пользователей обновлена на «Тапни счётчик».
screenshots: []
checks:
  - node --check bot/server.js
  - node inline JS validation for miniapp/index.html
  - node inline JS validation for design/prototype.html
  - git diff --check
deploy_url: https://azkar.nurtech.dev/app
---

Notes for editor:
- What changed: удалены обработчики `pointerdown`/`pointermove`/`pointerup`/`pointercancel`, стили `.tasbih.pulling`, `.tasbih.armed` и `touch-action: none` на счётчике. Обновлена подсказка «Тапни счётчик» и текст справки бота.
- Where to verify: открыть любой раздел азкаров, нажать на счётчик (значение увеличивается), провести пальцем по счётчику вверх/вниз (список скроллится).
