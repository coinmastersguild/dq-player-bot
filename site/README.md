# Live documentation

The main-game bot guide is served at **https://degenquest.ai/docs**, with raw Markdown at **https://degenquest.ai/docs.md**. The page includes this repo's quickstart, Claude operator tools, funding/deposit/withdrawal guide, live contracts, runtime and validation notes.

Build documentation with **Bun 1.3.9 or newer**:

```sh
bun site/build.mjs
```

The desktop app still requires only Node 22 and macOS build tools; Bun is for publishing the docs. Generated files remain under ignored `.local/site-docs/`: HTML, Markdown, discovery text, a source-hashed manifest and the self-contained `player-docs.mjs` Worker module. The site build has no network dependency and the generated Worker has no Bun dependency.

The production landing Worker calls the generated `documentationResponse(request)` only after its existing origin checks and wraps the response with its existing security headers. Unsupported paths return `null` and continue through the original handler. The documentation release uses its own `X-DQ-Docs-Release` header and retains the original Arena release header.

Documentation publication must retain the current live landing code, asset bundle, service bindings and secret bindings. Capture and verify the exact active Worker/version before upload, stop if it changes during preparation, and preserve its complete original module for rollback. Never rebuild/deploy the Arena or game merely to update these guides. Read credentials privately through the authorized Cloudflare operator configuration; do not put them in this repo, generated modules or logs.

`arena-reference.md` is the existing public Forest Arena/kingdom reference captured before the main-game guide became the primary page. It remains available at `/docs/arena` and `/docs/arena.md`, with an explicit mode distinction. The dedicated `/docs/kingdom.md`, `/docs/world.md`, `/docs/admission.ts` and `/mad/docs.md` routes keep their existing owners.
