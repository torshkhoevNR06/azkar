---
project: azkar
public: true
type: design
audience: users
title: Улучшены выборы, таджвид и библиотека азкаров
summary: В тёмно-золотой теме выбранные варианты стали заметнее, а цветовые правила Корана и типографика библиотеки азкаров приведены к общей системе.
user_impact: Выбор темы, палитры, режима и шрифта теперь визуально очевиден; смена темы проходит без рывка; аяты сохраняют центрирование и единую палитру правил; библиотека использует выбранный арабский шрифт и золотой цвет.
screenshots: []
checks:
  - "Invoke-WebRequest -UseBasicParsing http://localhost:5173/miniapp/index.html => 200"
  - "Browser smoke check: Quran reader renders centered tajweed ayahs in gold/dark theme"
deploy_url: http://localhost:5173/miniapp/index.html
---
