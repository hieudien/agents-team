---
name: code-standards
description: Coding standards for every change - correctness first, no comments, English only.
---
- Correct: handle empty/invalid input, errors and edge cases the requirement implies. Run it.
- Good: small functions, clear names, no duplication, follow existing style and folder structure.
- Agent friendly: one file per responsibility, predictable names, scripts for run/test in package.json or README.
- No comments of any kind. Names must explain the code.
- Only English in code, including UI text, unless the task explicitly asks for another UI language through a translation file.
- Before done: search the diff for "//", "/*", "#", "<!--" comment markers you added and remove them.
