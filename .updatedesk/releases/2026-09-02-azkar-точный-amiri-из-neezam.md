---
project: azkar
public: true
type: design
audience: users
title: Точный Amiri из neezam
summary: Для чтения азкаров основным выбран точный шрифт Amiri, используемый в neezam.
user_impact:
  - Экран чтения и предпросмотр в настройках по умолчанию используют Amiri вместо Amiri Quran.
  - В настройках шрифт прямо назван «Amiri» и отмечен как вариант neezam.
screenshots: []
checks:
  - git diff --check
  - SHA-256 локального amiri.woff2 совпадает с Arabic subset Amiri v30 из Google Fonts, который подключает azkars.ru
  - manual browser check: AzkarAmiri loaded and selected by default
deploy_url: http://127.0.0.1:3010/app/
---

Notes for editor:
- What changed: Switched the Azkar default and persisted font migration to the confirmed Amiri font, preloaded it, and aligned its mobile line height to the public neezam stylesheet.
- Where to verify: «Настройки» → «Шрифт арабского» — первой активной плиткой показан «Amiri».
- Risks: Users who deliberately selected another font are migrated once to Amiri; they can immediately choose any other option.
