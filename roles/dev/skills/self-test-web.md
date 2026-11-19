---
name: self-test-web
description: How to start a local web app, open it in the browser tool and verify it before reporting done.
---
1. Find how the project runs: package.json scripts, composer.json / artisan, index.html only.
2. Start the server in the background (run_in_background) on a free port:
   - Node: npm run dev or npx serve -l 5173
   - Laravel: php artisan serve --port=8001
   - Static: npx serve -l 5500 .
3. Use the playwright tools: navigate to the URL, take a snapshot, interact (click, fill forms), check console messages for errors.
4. Check every acceptance item on the page; for layout also check width 390px.
5. Stop the background server before answering.
6. Evidence format: "URL ... : saw ..., console: 0 errors".
