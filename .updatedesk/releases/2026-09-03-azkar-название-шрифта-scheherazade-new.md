---
project: azkar
public: true
type: feature
audience: users
title: Название шрифта Scheherazade New
summary: В настройках арабского шрифта рабочее название «Референс» заменено на реальное название гарнитуры Scheherazade New.
user_impact:
  - Пользователь видит реальное название выбранного арабского шрифта.
  - Подсказка к настройке стала понятнее и больше не выглядит как внутренняя рабочая метка.
screenshots: []
checks:
  - rg -n "Референс|как на референсе|шрифт референса" miniapp/index.html
  - Browser check: #fontSeg shows "Scheherazade New"; old "Референс" label is absent.
deploy_url: local only, http://localhost:5173/miniapp/index.html
---

Notes for editor:
- What changed: Переименована кнопка AzkarScheherazade в настройках азкаров и Корана, обновлены title/subtitle.
- Where to verify: Настройки → Шрифт арабского; Коран → настройки чтения → Шрифт арабского.
- Risks: Низкий, изменён только пользовательский текст названия.
