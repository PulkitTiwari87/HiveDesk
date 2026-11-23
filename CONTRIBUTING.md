# Contributing

Thanks for taking a look. Hivedesk is small on purpose, so changes should stay small too.

```bash
npm install
npm test        # unit tests (node:test), no real CLI agents needed
npm start       # run the app from source
npm run dist    # build the Windows exes into dist/
```

Guidelines:

- Keep the harness simple: plain Node and Electron, no frameworks, no new runtime dependency without a clear reason.
- The pixel office (`src/renderer/office.js`) draws everything with rectangles. Please do not add image assets.
- Anything that answers an agent's prompt on the user's behalf must only run when the user clicks it.
- Add or update a test in `test/` when you change the hive, message routing or agent status logic.
