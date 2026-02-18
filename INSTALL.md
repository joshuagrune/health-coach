# Health Coach Skill — Install

## Git Clone

```bash
# Into OpenClaw skills (shared)
git clone <repo-url> ~/.openclaw/skills/health-coach

# Or into workspace skills (per-agent)
git clone <repo-url> /path/to/workspace/skills/health-coach
```

## Scripts

Scripts live in **`{skill}/scripts/`** (e.g. `~/.openclaw/skills/health-coach/scripts/`). Coach data is in `workspace/health/coach/`.

```bash
# From workspace (OPENCLAW_WORKSPACE defaults to ~/.openclaw/workspace)
cd ~/.openclaw/workspace
node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js

# Or with explicit workspace
OPENCLAW_WORKSPACE=/path/to/workspace node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js
```

## Config

Add to `~/.openclaw/openclaw.json`:

```json
"skills": {
  "entries": {
    "health-coach": {
      "apiKey": "<your SALVOR_API_KEY>"
    }
  }
}
```

**Salvor is optional.** If `SALVOR_API_KEY` is set, the skill can sync and analyze your health data automatically. If not set, the agent will use manual intake to build your profile.

## Assessment-First Flow

On first use, the agent asks: "Should I sync and analyze your health data first (recommended)?" If yes and key exists, it runs `salvor-sync.js` then `profile-builder.js`. If no, it does manual intake and builds a profile from your answers.

## First Run

1. (Optional) Set `SALVOR_API_KEY` in config or env for data-driven profile.
2. Run `node ~/.openclaw/skills/health-coach/scripts/salvor-sync.js` (bootstrap 365d) — only if using Salvor.
3. Run `node ~/.openclaw/skills/health-coach/scripts/intake-from-goals.js` (or complete onboarding).
4. Run `node ~/.openclaw/skills/health-coach/scripts/profile-builder.js`.
5. Run `node ~/.openclaw/skills/health-coach/scripts/plan-generator.js`.

Cron jobs (if added) call these scripts from the skill folder.
