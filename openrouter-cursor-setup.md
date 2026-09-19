# OpenRouter + Cursor setup (copy to other repos)

Use this when Cursor’s included usage is exhausted. OpenRouter’s free tier routes through `openrouter/free` and individual `:free` models ([OpenRouter keys](https://openrouter.ai/keys)).

## 1. Get an API key

1. Sign in at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Create a key and copy it (starts with `sk-or-`).

You can reuse the same key in every repo; Cursor reads it from **Settings**, not from git.

## 2. Copy these files into the other repo

From this repo, copy:

| File | Purpose |
|------|---------|
| `.env.example` | Template for local env vars |
| `scripts/test-openrouter.sh` | Smoke-test standard + Cursor base URLs |
| `.cursor/rules/openrouter.mdc` | Reminds the agent how keys and URLs work |

Then in the target repo:

```bash
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY=sk-or-...
```

Ensure `.env` is gitignored (this repo uses `.env` in `.gitignore`). **Never commit the real key.**

## 3. Configure Cursor (once per machine)

In **Cursor → Settings → Models**:

1. Turn on **OpenAI API Key** and paste your OpenRouter key (same value as `OPENROUTER_API_KEY` in `.env`).
2. Turn on **Override OpenAI Base URL** and set:
   ```
   https://openrouter.ai/api/v1/cursor
   ```
   The `/cursor` suffix is required for Agent / tool use.
3. **+ Add model** → `openrouter/free` (optional extras: `openai/gpt-oss-20b:free`, `cohere/north-mini-code:free`).
4. In the chat model picker, choose `openrouter/free` when you want free routing.

Tab completion and default Auto/Composer still use Cursor’s built-in stack unless you change the picker.

## 4. Verify

From the repo root (needs `jq` and `curl`):

```bash
source .env
./scripts/test-openrouter.sh
```

You should see `http=200` for both `standard` (`https://openrouter.ai/api/v1`) and `cursor` (`https://openrouter.ai/api/v1/cursor`).

## 5. Use in scripts (OpenAI-compatible)

For app code or CLIs—not Cursor—use the **standard** base URL:

```bash
export OPENROUTER_API_KEY="sk-or-..."
# base: https://openrouter.ai/api/v1
# model: openrouter/free or any model id ending in :free
```

## Quick checklist

- [ ] `.env` created locally, not committed  
- [ ] `.cursor/rules/openrouter.mdc` present (optional but helpful for agents)  
- [ ] Cursor base URL is `.../api/v1/cursor`  
- [ ] `./scripts/test-openrouter.sh` passes  

## Limits

Free OpenRouter models are rate-limited (see the main [README](../README.md) OpenRouter section). Free providers may log prompts for training; avoid secrets in prompts.
