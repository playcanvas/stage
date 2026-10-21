---
description: Browse your local stages in the gallery
allowed-tools: Bash(open:*), Bash(xdg-open:*)
---

Call the `Stage` tool with `action: "list"` and show the result. Then open the gallery in the user's browser: take the host and port from any listed stage URL (default `http://localhost:47318`) and run `open <base>/stages` (on Linux, `xdg-open`). If no stages exist yet, say so and skip opening the gallery.
