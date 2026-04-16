---
name: Bug report
about: Report something that does not work as expected
title: "[Bug] "
labels: bug
assignees: ''
---

## What happened

A clear description of what went wrong.

## What you expected

What did you expect to happen instead?

## Steps to reproduce

1. Ran `aeo-tracker init` with …
2. Set env vars `…`
3. Ran `aeo-tracker run`
4. Saw error …

## Environment

- `aeo-tracker` version: (run `aeo-tracker --version`)
- Node.js version: (run `node --version`)
- OS: (macOS / Linux / Windows + version)
- Providers used: (OpenAI / Gemini / Anthropic — which were active)

## Config & output

Paste your `.aeo-tracker.json` (redact API keys if any leaked in) and the full CLI output:

```
paste here
```

## Raw response (if applicable)

If the issue is about how a specific provider response was parsed, paste the relevant file from `aeo-responses/{date}/` (or link to a gist).
