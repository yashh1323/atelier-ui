# 05 — Tiered QA & Zero-Context Critic Gate

Execute checks in strict order based on `<skill>/scripts/detect-env.mjs` output. Never claim a check passed unless you ran it after your final edit (`<skill>` is the directory containing `SKILL.md`; always quote `"<skill>/..."` in commands).

## Tier 1: Deterministic Static Lint (0 LLM Tokens)
- **If `detect-env.mjs` reports `tools.impeccableCmd`:** run it against the authored directory/files:
  ```bash
  <tools.impeccableCmd> detect <target-dir>
  ```
- **Always / Zero-Install Fallback:**
  ```bash
  node "<skill>/scripts/lint-ui.mjs" <target-dir-or-files>
  ```
  On existing Tailwind/shadcn repos, target your authored directories/files (for example `src/app src/components/dashboard`) so third-party `components/ui/*` primitives do not cause unrelated noise. Fix every `FAIL` before opening a browser.

## Tier 2: Live Browser & Responsive Check
For Next.js, Vite, Astro, Svelte, or Vue projects, start `project.devCommand` from `detect-env.mjs` in the background, wait until `http://127.0.0.1:<port>` responds, run one of the options below, and stop the dev server cleanly afterward (note: auth-gated routes need a public/demo route or an authenticated interactive browser session):

1. **If `tools.agentBrowser` is true:** Open desktop (`1440x900`) and mobile (`390x844`), inspect `@e` interactive element refs (provided by `agent-browser snapshot`), test interactive tabs/forms/states, check console errors, and capture `.atelier/shots/desktop-1440.png` and `mobile-390.png` (plus `desktop-1440-full.png` and `mobile-390-full.png` when `QA Depth` is `critic` or `deep`).
2. **Else if your coding agent provides a built-in browser tool/subagent:** Open the local URL, verify desktop (`1440x900`) and mobile (`390x844`) layouts, click through key UI states, and save screenshots using the same filenames in `.atelier/shots/`.
3. **Else (Built-in Chrome DevTools Protocol [CDP] runner, requires Node 22+ and Chrome/Edge/Chromium/Brave):**
   ```bash
   node "<skill>/scripts/check-ui.mjs" <url-or-html-file-or-dir> --out .atelier/shots [--wait 1200] [--full] [--sheet] [--routes /,/about] [--shots S01,S02] [--ref path.png] [--allow-pending-anchors]
   ```
   When `QA Depth` is `critic` or `deep`, pass `--full --sheet` so `desktop-1440-full.png`, `mobile-390-full.png`, and a side-by-side `review-sheet.png` are captured too (and pass `--routes` for multi-page sites or `--shots` for multi-angle 3D builds). `check-ui.mjs` returns `FAIL` (exit `1`) on: navigation failure, horizontal overflow (`overflowX`), broken images, zero-size visible `<canvas>`/`<svg>` (`emptyMedia`), sticky/fixed headers overlapping `<h1>` (`headerOverlaps`), failed asset/font HTTP loads (`failedRequests` / `fontSummary.failedCount`), blank renders (`pixelSanity.blankViewport`), dead `#` links, WCAG AA low contrast, tiny text (`< 12px`), uncaught page errors, and `console.error` calls. Fix every `FAIL` and re-run to confirm `PASS`.

## Tier 3: Zero-Context Critic Pass (When `QA Depth` is `critic` or `deep`)
Spawn **one** fresh subagent on a fast/lightweight vision-capable model with **NO code access and NO prior conversation context**. Prefer passing `.atelier/shots/review-sheet.png` first (or individual desktop/mobile full captures when vertical inspection matters) to halve vision token spend. For UI builds use the rubric below; for `3D` builds (`<skill>/modules/04-3d-visual.md`), score `Composition, Lighting, Color/Materials, Craft`:

```text
You are a strict design director seeing this UI for the first time.
Review the desktop (1440px) and mobile (390px) screenshots.
Score 1-10 on: Hierarchy, Typography, Color/Contrast, Spacing/Alignment, Craft (zero AI slop).
List the top 3 concrete visual defects (exact location, what looks off, exact fix).
If all dimensions are >= 8 and no layout defects exist, verdict: SHIP. Else: FIX.
```

- If verdict is `FIX`, fix all 3 defects in one clean batch, re-run Tier 1 & Tier 2 checks, log scores in `.atelier/ROUNDS.md` when `deep`, and finish (capped by `.atelier/BRIEF.md`).
- If subagents are unavailable, audit the screenshots directly against the rubric and report any limitations candidly.
- **Repo hygiene:** Unless the user wants `.atelier/` kept, add `.atelier/` to `.gitignore` or remove temporary screenshots before final commit/handoff.
