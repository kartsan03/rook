# Contributing

## Setup

```
git clone https://github.com/kartsan03/rook
cd rook
npm install
npm test
```

Manual runs additionally need [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on
your PATH and at least one API key in `.env` (see `.env.example`).

## Ground rules

- Revenue math stays in code (`src/metrics.js`). The LLM writes prose around
  numbers it cannot change; do not let it compute money.
- New logic goes in pure functions with unit tests (`node --test`).
- No new runtime dependencies without a strong reason.
- Scraped data and generated dossiers are personal data and never get
  committed; `data/`, `audits/`, and `targets.txt` stay gitignored.

## Pull requests

Keep them small. CI runs a syntax check plus the test suite on Node 20 and 22.
