---
name: web-testing
description: Test a web feature in the browser against an acceptance checklist and collect evidence.
---
1. Start the app the way the dev described (background), wait until the URL answers.
2. For each acceptance item: navigate, act, observe with snapshot, record result and evidence.
3. Edge cases: empty input, invalid input, reload page, back button, width 390px.
4. Check console messages for errors and failed network requests.
5. Run existing automated tests if any (npm test, php artisan test).
6. Stop the server.
