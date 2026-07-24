# PanePilot documentation

This directory contains the Fumadocs site for PanePilot. It documents the product that
exists in the repository today, its operating model, architecture, safety boundaries,
and the path for future project types.

## Run locally

Node.js 22 or newer is required.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The docs are served at `/docs`; the root route provides
an overview and links into the guide.

## Validate

```bash
npm run typecheck
npm run build
```

The site also publishes:

- `/api/search` for the built-in documentation search.
- `/llms.txt` as an index for language models.
- `/llms-full.txt` as the complete documentation corpus.
- A Markdown representation of each page by appending `.md` to its docs URL.

## Authoring

Documentation pages live under `content/docs`. Use each folder's `meta.json` to control
navigation order. Update claims about current behavior against the application code,
especially lifecycle tracking: architecture decisions in `AGENTS.md` may describe the
target design before it is implemented.
