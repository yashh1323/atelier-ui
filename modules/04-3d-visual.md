# 04 — Procedural 3D, WebGL & Shaders (`3D`)

Use this module **only** for Three.js, WebGL/WebGPU scenes, or generative shaders (kept compact for reasonable token budgets).

## 1. Dependencies & Deterministic Capture
1. Bundle `three` locally (e.g., Vite + `npm install three`) or write inline WebGL GLSL shaders—never rely on external CDNs that fail offline or in sandboxed headless runs.
2. Support **both** interactive playback (`requestAnimationFrame`) and deterministic still inspection via URL parameters (for example `?shot=S01&frame=12`, computing time strictly from `frameIndex / fps` and setting `window.__ATELIER_READY__ = true` once rendered).
3. Write `.atelier/SHOTS.md` upfront so every round compares identical framing:

```markdown
| Shot | Label | Camera Pos | Target | FOV | Lighting Mood |
|---|---|---|---|---|---|
| S01 | Hero Oblique | (0, 2.2, 4.4) | (0, 0.35, 0) | 45 deg | Warm rim, dark key |
```

## 2. Quality & Software-Rasterizer Guardrails
- Keep the realtime preview lightweight (modest raymarch step counts / shadow resolution).
- **Lighting & tone-mapping baseline:** Default Three.js `WebGLRenderer` to `ACESFilmicToneMapping` (`toneMappingExposure: 1.05–1.2`) with 3-point separation (`key` warm directional `~2.4`, cool `fill`/hemisphere `~0.65`, crisp back `rim` `~1.8`) so dark scenes read volumetrically instead of flat gray.
- Note that headless verification (`check-ui.mjs`) enables SwiftShader software WebGL (`--enable-unsafe-swiftshader` across platforms; Direct3D WARP / SwiftShader on Windows/macOS and ANGLE SwiftShader on Linux), so keep preview raymarch step counts modest and verify zero GLSL/WebGL `console.error` output early.
- For high-resolution offline stills (when exporting beauty renders), apply multi-sample sub-frame accumulation (jittering sub-pixel offset for anti-aliasing [AA] and lens offset for depth of field [DoF]).
- Catch washed-out or blank canvases early via `check-ui.mjs --shots S01,S02 --sheet` (`pixelSanity.stdDev` + `blankViewport`, plus `emptyMedia` for 0px canvases).

## 3. Bounded Iterative Loop (`.atelier/ROUNDS.md`)
Enforce your brief's round cap (for example, max 3–5 rounds):
1. Pick the single weakest visual dimension (composition, lighting, color/materials, or edge detail).
2. Capture shot stills (pass `--wait 1200` if shaders compile asynchronously).
3. Review renders (pass `--ref .atelier/refs/R01.png --sheet` when a reference image is provided, or review `.atelier/shots/review-sheet.png` against the lighting/palette goal in `.atelier/BRIEF.md`) using a fresh zero-context critic subagent scored 1–10 on **Composition, Lighting, Color/Materials, Craft** (`>= 8` on all to `SHIP`).
4. Log scores and next fix in `.atelier/ROUNDS.md`:

```markdown
| Round | Focus | Measured Checks | Critic Scores (Co/Li/Ma/Cr) | Verdict |
|---|---|---|---|---|
| 01 | Initial GLSL terrain (`S01`) | `lint-ui`: 0 FAIL; `check-ui --full`: PASS | 9 / 9 / 8 / 9 | SHIP |
```

5. **Quota discipline:** Stop cleanly when `SHIP` is reached or the round cap is hit; never loop indefinitely.
