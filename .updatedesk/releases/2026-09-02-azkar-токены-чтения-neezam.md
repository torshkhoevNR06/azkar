---
project: azkar
public: true
type: design
audience: users
title: Токены чтения neezam
summary: Экран чтения азкаров использует подтверждённые из neezam размеры текста, цвета и стеклянный материал тёмной карточки.
user_impact:
  - Значения арабского текста, перевода и источника соответствуют реальным токенам neezam.
  - Светлая золотая тема сохраняет золотой арабский текст и не получает горизонтальную прокрутку.
screenshots: []
checks:
  - git diff --check
  - manual browser check: dark gold reader computed against neezam source tokens
  - manual browser check: light gold reader, Arabic and card have no horizontal overflow
  - manual browser check: every available Arabic font at 39px plus Amiri at 24px and 44px, with no horizontal overflow
deploy_url: http://127.0.0.1:3010/app/
---

Notes for editor:
- What changed: Derived reader typography and dark-gold material tokens from azkars.ru/style.css and glass.css, the public neezam implementation.
- Where to verify: Open any Azkar section in dark gold; then switch to the light gold theme and verify the Arabic text remains gold.
- Risks: The default Arabic size is 21px, matching the neezam mobile CSS at a 428px viewport; existing saved user sizes remain intact.
