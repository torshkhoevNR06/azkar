---
project: azkar
public: true
type: design
audience: users
title: Ярче кнопки в золотой теме
summary: В золотой теме усилены цвета вторичных кнопок, иконок и переключателей, чтобы они не выглядели тускло на тёмно-коричневом фоне.
user_impact: Элементы управления в тасбихе, чтении азкаров, настройках, модалках и разделе Корана стали заметнее и читаемее, сохранив общую тёмно-золотую стилистику.
screenshots: []
checks:
  - "Invoke-WebRequest -UseBasicParsing http://localhost:5173/miniapp/index.html => 200"
  - "Browser smoke check: miniapp renders in gold/dark theme"
deploy_url: http://localhost:5173/miniapp/index.html
---
