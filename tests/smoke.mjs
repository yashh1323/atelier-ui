#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCaptureTargets, resolveSafeFile } from '../scripts/check-ui.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runNode(scriptRel, args = [], cwd = ROOT) {
  return spawnSync(process.execPath, [join(ROOT, scriptRel), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function runNodeAsync(scriptRel, args = [], cwd = ROOT) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, scriptRel), ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function hexContrastRatio(hex1, hex2) {
  const lum = (hex) => {
    const rgb = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => {
      const s = parseInt(h, 16) / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const l1 = lum(hex1);
  const l2 = lum(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('SKILL.md frontmatter and referenced files exist', () => {
  const skillMd = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\r?\n[\s\S]*?\bname:\s*atelier-ui\b[\s\S]*?\bdescription:\s*.+/);

  const refs = [
    'modules/01-intake.md',
    'modules/02-brand-site.md',
    'modules/03-app-ui.md',
    'modules/04-3d-visual.md',
    'modules/05-qa-gate.md',
    'library/themes.json',
    'scripts/detect-env.mjs',
    'scripts/lint-ui.mjs',
    'scripts/check-ui.mjs',
  ];
  for (const rel of refs) {
    assert.ok(existsSync(join(ROOT, rel)), `Missing referenced skill file: ${rel}`);
  }
});

test('library/themes.json has valid schema, business kinds, and WCAG AA contrast', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'library/themes.json'), 'utf8'));
  assert.ok(Array.isArray(raw.themes) && raw.themes.length >= 5, 'Expected at least 5 themes');

  const validKinds = new Set(['software', 'gaming', 'tech', 'product', 'service', 'place']);
  const requiredTokens = ['--bg', '--surface', '--ink', '--muted', '--accent', '--accent-ink', '--border'];
  for (const theme of raw.themes) {
    assert.ok(theme.id && typeof theme.id === 'string', 'Theme missing id');
    assert.ok(Array.isArray(theme.fit) && theme.fit.length > 0, `Theme ${theme.id} missing fit`);
    for (const k of theme.fit) assert.ok(validKinds.has(k), `Theme ${theme.id} invalid fit kind ${k}`);
    assert.ok(theme.vibe && typeof theme.vibe === 'string', `Theme ${theme.id} missing vibe`);
    assert.ok(theme.radius && typeof theme.radius === 'string', `Theme ${theme.id} missing radius`);
    assert.ok(theme.surface?.elevation && theme.surface?.shadow && theme.surface?.ease && theme.surface?.focusRing, `Theme ${theme.id} missing surface tokens`);
    for (const tok of requiredTokens) {
      assert.match(theme.tokens?.[tok] || '', /^#[0-9A-Fa-f]{6}$/, `Theme ${theme.id} invalid token ${tok}`);
    }
    assert.ok(theme.fonts?.display && theme.fonts?.body && theme.fonts?.mono, `Theme ${theme.id} missing fonts`);
    assert.ok(Array.isArray(theme.weights?.display) && theme.weights.display.length > 0, `Theme ${theme.id} missing display weights`);
    assert.ok(Array.isArray(theme.weights?.body) && theme.weights.body.length > 0, `Theme ${theme.id} missing body weights`);
    const t = theme.tokens;
    assert.ok(hexContrastRatio(t['--ink'], t['--bg']) >= 4.5, `${theme.id} --ink/--bg contrast < 4.5`);
    assert.ok(hexContrastRatio(t['--ink'], t['--surface']) >= 4.5, `${theme.id} --ink/--surface contrast < 4.5`);
    assert.ok(hexContrastRatio(t['--muted'], t['--bg']) >= 4.5, `${theme.id} --muted/--bg contrast < 4.5`);
    assert.ok(hexContrastRatio(t['--muted'], t['--surface']) >= 4.5, `${theme.id} --muted/--surface contrast < 4.5`);
    assert.ok(hexContrastRatio(t['--accent-ink'], t['--accent']) >= 4.5, `${theme.id} --accent-ink/--accent contrast < 4.5`);
  }
});

test('detect-env.mjs outputs valid environment JSON', () => {
  const res = runNode('scripts/detect-env.mjs');
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.cwd, ROOT);
  assert.ok(parsed.nodeVersion.startsWith('v'));
  assert.equal(typeof parsed.project?.framework, 'string');
  assert.equal(typeof parsed.tools?.agentBrowser, 'boolean');
  assert.equal(typeof parsed.tools?.impeccableCli, 'boolean');
  assert.equal(typeof parsed.tools?.cdpSupported, 'boolean');
});

test('detect-env.mjs detects Next.js/pnpm/shadcn, Vite/Three.js, and invalid package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-env-test-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'mock-next-app',
        scripts: { dev: 'next dev' },
        dependencies: { next: '15.0.0', react: '19.0.0' },
        devDependencies: { tailwindcss: '4.0.0' },
      })
    );
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    writeFileSync(join(dir, 'components.json'), '{}');
    writeFileSync(join(dir, 'product.md'), '# Product');
    writeFileSync(join(dir, 'DESIGN.md'), '# Design');

    const res = runNode('scripts/detect-env.mjs', [], dir);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.project.hasPackageJson, true);
    assert.equal(parsed.project.packageJsonValid, true);
    assert.equal(parsed.project.framework, 'nextjs');
    assert.equal(parsed.project.packageManager, 'pnpm');
    assert.equal(parsed.project.devCommand, 'pnpm dev');
    assert.equal(parsed.project.tailwind, true);
    assert.equal(parsed.project.shadcn, true);
    assert.equal(parsed.project.hasProductMd, true);
    assert.equal(parsed.project.hasDesignMd, true);

    const viteDir = mkdtempSync(join(tmpdir(), 'atelier-vite-test-'));
    try {
      writeFileSync(
        join(viteDir, 'package.json'),
        JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { three: '0.170.0' }, devDependencies: { vite: '6.0.0' } })
      );
      const viteRes = JSON.parse(runNode('scripts/detect-env.mjs', [], viteDir).stdout);
      assert.equal(viteRes.project.framework, 'vite');
      assert.equal(viteRes.project.threejs, true);
      assert.equal(viteRes.project.devCommand, 'npm run dev');
    } finally {
      rmSync(viteDir, { recursive: true, force: true });
    }

    writeFileSync(join(dir, 'package.json'), '{broken');
    const brokenRes = JSON.parse(runNode('scripts/detect-env.mjs', [], dir).stdout);
    assert.equal(brokenRes.project.hasPackageJson, true);
    assert.equal(brokenRes.project.packageJsonValid, false);

    // Directory CHROME_PATH must be ignored (not treated as an executable binary)
    const dirChromeRes = spawnSync(process.execPath, [join(ROOT, 'scripts', 'detect-env.mjs')], {
      cwd: dir,
      env: { ...process.env, CHROME_PATH: dir },
      encoding: 'utf8',
    });
    assert.equal(dirChromeRes.status, 0, dirChromeRes.stderr);
    assert.notEqual(JSON.parse(dirChromeRes.stdout).tools.browserBinary, dir);

    // Junction / symlink invocation must execute CLI instead of exiting silently
    const linkParent = mkdtempSync(join(tmpdir(), 'atelier-link-'));
    try {
      const linkPath = join(linkParent, 'atelier-linked');
      symlinkSync(ROOT, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      const linkRes = spawnSync(process.execPath, [join(linkPath, 'scripts', 'detect-env.mjs')], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(linkRes.status, 0, linkRes.stderr);
      const linkJson = JSON.parse(linkRes.stdout);
      assert.equal(linkJson.cwd, dir);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint-ui.mjs handles clean fixtures, JSX, multi-ID disables, comments, and multi-line CSS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-lint-test-'));
  try {
    const cleanHtml = join(dir, 'clean.html');
    const cleanCss = join(dir, 'clean.css');
    const cleanTsx = join(dir, 'Clean.tsx');
    writeFileSync(
      cleanCss,
      `.card-body,
tbody,
body .drawer {
  overflow-x: hidden;
}
button:focus { outline: none; }
button:focus-visible { outline: 2px solid #111111; }
`
    );
    writeFileSync(
      cleanTsx,
      `export function Shell() {
  return (
    <div className="max-w-screen-xl mx-auto">
      <button className="focus-visible:outline-none focus-visible:ring-2">Save changes</button>
    </div>
  );
}
`
    );
    writeFileSync(
      cleanHtml,
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Clean</title>
  <style>a:focus { outline: none; } a:focus-visible { outline: 2px solid #111111; }</style>
</head>
<body>
  <main>
    <h1>Handcrafted workspace</h1>
    <!--
      Multi-line HTML comment should be ignored:
      <p class="eyebrow">Acme</p>
      <a href="#">Learn more</a>
    -->
    <p>Choose what to do next in your queue.</p>
    <a href="#open">Open workspace</a>
  </main>
</body>
</html>
`
    );

    const cleanRes = runNode('scripts/lint-ui.mjs', ['--json', cleanHtml, cleanCss, cleanTsx]);
    assert.equal(cleanRes.status, 0, cleanRes.stdout);
    const cleanJson = JSON.parse(cleanRes.stdout);
    assert.equal(cleanJson.filesScanned, 3);
    assert.equal(cleanJson.fails, 0);
    assert.equal(cleanJson.warns, 0);

    const dirtyHtml = join(dir, 'dirty.html');
    writeFileSync(
      dirtyHtml,
      `<style>
  html,
  body {
    overflow-x: hidden;
  }
  .box { width: 100vw; transition: all 0.2s; outline: none; }
  .multi-suppressed { width: 100vw; transition: all 0.2s; /* atelier-disable no-100vw no-transition-all */ }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
<p class="eyebrow">New Release</p>
<h1>Launch Headline</h1>
<p>Built for Acme teams with TODO metrics</p>
<a href="#more">Learn more</a>
<p>Suppressed · meta <!-- atelier-disable no-middot-meta --></p>
`
    );

    const dirtyRes = runNode('scripts/lint-ui.mjs', [dirtyHtml, '--json']);
    assert.equal(dirtyRes.status, 1, dirtyRes.stdout);
    const dirtyJson = JSON.parse(dirtyRes.stdout);
    const rules = dirtyJson.findings.map((f) => f.rule);
    assert.ok(dirtyJson.findings.some((f) => f.rule === 'no-overflow-x-hidden-root' && f.line === 2));
    assert.ok(rules.includes('no-100vw'));
    assert.ok(rules.includes('no-transition-all'));
    assert.ok(rules.includes('no-outline-none'));
    assert.ok(rules.includes('no-placeholder-copy'));
    assert.ok(rules.includes('no-generic-learn-more'));
    assert.ok(rules.includes('no-eyebrow-kicker'));
    assert.ok(rules.includes('reduced-motion'));
    assert.equal(dirtyJson.findings.filter((f) => f.line === 7).length, 0, 'Multi-ID disable should suppress line 7');
    assert.equal(dirtyJson.findings.filter((f) => f.line === 14).length, 0, 'Inline disable comment should suppress line 14');

    const dirtyTsx = join(dir, 'Hero.tsx');
    writeFileSync(
      dirtyTsx,
      `export function Hero() {
  return (
    <section className="w-screen transition-all outline-none from-purple-600 to-blue-500">
      <div className="eyebrow">Release 2.0</div>
      <h1 className="bg-clip-text">Ship faster</h1>
      <p>Austin · Live</p>
      {/* JSX comment · ignored */}
      <div className="w-screen" /* atelier-disable no-100vw */ />
      <p>Suppressed · middot {/* atelier-disable no-middot-meta */}</p>
      <button className="focus-visible:outline-none">Bad focus</button>
    </section>
  );
}
`
    );

    const tsxRes = runNode('scripts/lint-ui.mjs', ['--json', dirtyTsx]);
    assert.equal(tsxRes.status, 1, tsxRes.stdout);
    const tsxJson = JSON.parse(tsxRes.stdout);
    const tsxRules = tsxJson.findings.map((f) => f.rule);
    for (const r of ['no-100vw', 'no-transition-all', 'no-outline-none', 'no-purple-gradient-slop', 'no-gradient-text-slop', 'no-eyebrow-kicker', 'no-middot-meta']) {
      assert.ok(tsxRules.includes(r), `Expected JSX rule ${r}`);
    }
    assert.equal(tsxJson.findings.filter((f) => f.line === 7).length, 0);
    assert.equal(tsxJson.findings.filter((f) => f.line === 8).length, 0);
    assert.equal(tsxJson.findings.filter((f) => f.line === 9).length, 0);
    assert.ok(tsxJson.findings.some((f) => f.line === 10 && f.rule === 'no-outline-none'), 'Bare focus-visible:outline-none on line 10 must fail');

    const unknownFlagRes = runNode('scripts/lint-ui.mjs', ['--unknown-flag']);
    assert.equal(unknownFlagRes.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSafeFile blocks path traversal and sibling-prefix escapes', () => {
  const root = resolve(tmpdir(), 'atelier-site');
  const entry = join(root, 'index.html');
  assert.equal(resolveSafeFile(root, entry, '/styles.css').status, 200);
  assert.equal(resolveSafeFile(root, entry, '/../secret.txt').status, 403);
  assert.equal(resolveSafeFile(root, entry, '/../atelier-site-other/secret.txt').status, 403);
  assert.equal(resolveSafeFile(root, entry, '/%2e%2e/atelier-site-other/secret.txt').status, 403);
  assert.equal(resolveSafeFile(root, entry, '/%ZZ').status, 400);
});

test('check-ui.mjs verifies clean/failing fixtures, console.error, tinyText, oklch contrast, and canvas overlays', (t) => {
  const envRes = runNode('scripts/detect-env.mjs');
  const env = JSON.parse(envRes.stdout);
  if (!env.tools.browserBinary || typeof WebSocket === 'undefined') {
    t.skip('No local Chrome/Edge binary or Node <22 WebSocket available');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'atelier-cdp-test-'));
  try {
    const cleanDir = join(dir, 'clean');
    mkdirSync(cleanDir);
    writeFileSync(
      join(cleanDir, 'index.html'),
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clean Fixture</title>
  <style>
    html, body { margin: 0; overflow-x: clip; font-size: 16px; background: #ffffff; color: #111111; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px; position: relative; }
    .hero-grad { background: linear-gradient(135deg, #101218, #1e2430); color: #ffffff; padding: 24px; }
    .canvas-stage { position: relative; height: 140px; }
    .canvas-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .canvas-hud { position: relative; z-index: 1; color: #ffffff; padding: 16px; }
    .sib-stage { position: relative; height: 90px; }
    .sib-bg { position: absolute; inset: 0; background: #101216; }
    .sib-fg { position: relative; z-index: 1; background: rgba(255, 255, 255, 0.2); color: #ffffff; padding: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; clip: rect(0, 0, 0, 0); overflow: hidden; font-size: 8px; color: #cccccc; }
  </style>
</head>
<body>
  <main>
    <nav><a href="#later-section">Jump later</a></nav>
    <h1>Atelier UI Smoke Test</h1>
    <span class="sr-only">Screen-reader-only label must not trigger tinyText or lowContrast</span>
    <div class="hero-grad"><p>Light text over gradient ancestor must not false-fail contrast.</p></div>
    <div class="sib-stage">
      <div class="sib-bg"></div>
      <div class="sib-fg"><p>White text inside translucent card over dark sibling</p></div>
    </div>
    <div class="canvas-stage">
      <canvas id="gl"></canvas>
      <div class="canvas-hud"><p>White HUD over sibling WebGL canvas</p></div>
    </div>
  </main>
  <script>
    window.__ATELIER_READY__ = false;
    const gl = document.getElementById('gl').getContext('webgl2');
    if (!gl) console.error('WebGL2 context failed');
    setTimeout(() => { window.__ATELIER_READY__ = true; }, 60);
  </script>
</body>
</html>
`
    );

    const passRes = runNode('scripts/check-ui.mjs', [
      `${join(cleanDir, 'index.html')}?shot=S01&frame=12`,
      '--out',
      join(dir, 'shots'),
      '--wait=50',
      '--full',
      '--allow-pending-anchors',
    ]);
    assert.equal(passRes.status, 0, `${passRes.stdout}\n${passRes.stderr}`);
    const passJson = JSON.parse(passRes.stdout);
    assert.equal(passJson.status, 'PASS');
    assert.equal(passJson.results.length, 2);
    for (const vp of passJson.results) {
      assert.equal(vp.overflowX, false);
      assert.equal(vp.tinyText, 0);
      assert.equal(vp.h1Visible, true);
      assert.deepEqual(vp.deadLinks, []);
      assert.deepEqual(vp.lowContrast, []);
      assert.deepEqual(vp.consoleErrors, []);
      assert.ok(statSync(vp.screenshot).size > 0);
      assert.ok(statSync(vp.fullScreenshot).size > 0);
    }

    const defectsHtml = join(dir, 'defects.html');
    writeFileSync(
      defectsHtml,
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Defects Fixture</title>
  <style>
    body { margin: 0; background: #ffffff; color: #111111; font-size: 16px; }
    .washed-oklch { color: oklch(0.84 0.02 250); }
    .tiny { font-size: 9px; }
  </style>
</head>
<body>
  <main id="valid-target">
    <h1>Defects Check</h1>
    <p class="washed-oklch">Oklch faint contrast check</p>
    <p class="tiny">Microscopic body copy</p>
    <a href="#">Placeholder link</a>
    <a href="#%ZZ">Malformed anchor</a>
    <a href="#missing-section">Broken anchor</a>
    <a href="#valid-target">Valid anchor</a>
  </main>
  <script>console.error('Simulated hydration mismatch error');</script>
</body>
</html>
`
    );
    const defectsRes = runNode('scripts/check-ui.mjs', [defectsHtml, `--out=${join(dir, 'shots-defects')}`, '--wait=200']);
    assert.equal(defectsRes.status, 1, defectsRes.stdout);
    const defectsJson = JSON.parse(defectsRes.stdout);
    assert.equal(defectsJson.status, 'FAIL');
    const d0 = defectsJson.results[0];
    assert.equal(d0.deadLinks.length, 3);
    assert.ok(d0.lowContrast.length >= 1, 'Expected oklch low-contrast detection');
    assert.ok(d0.tinyText >= 1, 'Expected tinyText >= 1');
    assert.ok(d0.consoleErrors.some((msg) => msg.includes('Simulated hydration mismatch error')), 'Expected console.error capture');

    const badFlagRes = runNode('scripts/check-ui.mjs', [defectsHtml, '--out']);
    assert.equal(badFlagRes.status, 2);
    assert.equal(runNode('scripts/check-ui.mjs', [defectsHtml, '--wait=']).status, 2);

    const fakeBin = join(dir, 'not-a-browser.txt');
    writeFileSync(fakeBin, 'not executable');
    const badSpawnRes = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-ui.mjs'), defectsHtml, '--out', join(dir, 'shots-bad-bin')], {
      cwd: ROOT,
      env: { ...process.env, CHROME_PATH: fakeBin },
      encoding: 'utf8',
    });
    assert.notEqual(badSpawnRes.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-ui.mjs verifies live HTTP server and fails on unreachable HTTP server', async (t) => {
  const envRes = runNode('scripts/detect-env.mjs');
  const env = JSON.parse(envRes.stdout);
  if (!env.tools.browserBinary || typeof WebSocket === 'undefined') {
    t.skip('No local Chrome/Edge binary or Node <22 WebSocket available');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'atelier-http-test-'));
  const srv = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Server Check</title>
  <style>
    html, body { margin: 0; overflow-x: clip; background: #0F1012; color: #F2F0EC; font-family: system-ui, sans-serif; }
    main { max-width: 960px; margin: 0 auto; padding: 48px 24px; min-height: 1200px; }
    a { color: #E07A48; }
  </style>
</head>
<body>
  <main id="top">
    <h1>Live HTTP Target</h1>
    <p>Served from an external Node HTTP server.</p>
    <a href="#top">Back to top</a>
  </main>
</body>
</html>`);
  });

  try {
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/`;
    const res = await runNodeAsync('scripts/check-ui.mjs', [url, '--out', join(dir, 'shots-http'), '--full']);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.status, 'PASS');
    assert.equal(parsed.results.length, 2);

    // Close server and verify unreachable URL cleanly FAILS instead of passing on chrome-error://
    srv.closeAllConnections?.();
    await new Promise((ok) => srv.close(ok));
    const deadRes = await runNodeAsync('scripts/check-ui.mjs', [url, '--out', join(dir, 'shots-dead')]);
    assert.equal(deadRes.status, 1, deadRes.stdout);
    const deadJson = JSON.parse(deadRes.stdout);
    assert.equal(deadJson.status, 'FAIL');
    assert.ok(deadJson.results.some((r) => Boolean(r.navigationError)), 'Expected navigationError on dead URL');
  } finally {
    try { srv.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill word-budget and markdown local asset links stay intact', () => {
  const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;
  const skillWords = countWords(readFileSync(join(ROOT, 'SKILL.md'), 'utf8'));
  assert.ok(skillWords <= 750, `SKILL.md bloated to ${skillWords} words (cap: 750)`);

  for (const mod of ['01-intake.md', '02-brand-site.md', '03-app-ui.md', '04-3d-visual.md', '05-qa-gate.md']) {
    const modWords = countWords(readFileSync(join(ROOT, 'modules', mod), 'utf8'));
    assert.ok(modWords <= 650, `modules/${mod} bloated to ${modWords} words (cap: 650)`);
  }

  for (const mdRel of ['README.md', 'docs/PROOFS.md', 'SKILL.md', 'modules/01-intake.md', 'modules/02-brand-site.md', 'modules/03-app-ui.md', 'modules/04-3d-visual.md', 'modules/05-qa-gate.md']) {
    const mdAbs = join(ROOT, mdRel);
    const mdDir = dirname(mdAbs);
    const md = readFileSync(mdAbs, 'utf8');
    for (const m of md.matchAll(/(?:\]\(|src=")([^)"\s#]+)(?:#[^)"\s]*)?(?:\)|")/g)) {
      const target = m[1];
      if (/^(?:https?:|mailto:|#|<)/i.test(target)) continue;
      assert.ok(existsSync(join(mdDir, target)), `${mdRel} references missing local path: ${target}`);
    }
  }
});

test('bin/atelier-ui.mjs handles flags, real link creation, conflict skip, --force, and doctor', () => {
  const helpFirst = runNode('bin/atelier-ui.mjs', ['--help']);
  assert.equal(helpFirst.status, 0, helpFirst.stderr);
  assert.match(helpFirst.stdout, /Usage:/);

  const ver = runNode('bin/atelier-ui.mjs', ['version']);
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const fakeHome = mkdtempSync(join(tmpdir(), 'atelier-cli-home-'));
  try {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    const runCli = (args) =>
      spawnSync(process.execPath, [join(ROOT, 'bin', 'atelier-ui.mjs'), ...args], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
      });

    const dryRes = runCli(['install', '--host', 'claude', '--dry-run']);
    assert.equal(dryRes.status, 0, dryRes.stderr);
    assert.match(dryRes.stdout, /PLAN \[claude\]/);

    const instRes = runCli(['install', '--host', 'claude']);
    assert.equal(instRes.status, 0, instRes.stderr);
    assert.match(instRes.stdout, /DONE \[claude\]/);

    const docRes = runCli(['--json', 'doctor']);
    assert.equal(docRes.status, 0, docRes.stderr);
    const doc = JSON.parse(docRes.stdout);
    assert.equal(doc.hosts.find((h) => h.id === 'claude')?.status, 'linked');

    const againRes = runCli(['install', '--host', 'claude']);
    assert.equal(againRes.status, 0, againRes.stderr);
    assert.match(againRes.stdout, /OK\s+\[claude\] already linked/);

    // Conflict: replace link with unmanaged directory, confirm skip without --force and overwrite with --force
    const dest = join(fakeHome, '.claude', 'skills', 'atelier-ui');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const skipRes = runCli(['install', '--host', 'claude']);
    assert.equal(skipRes.status, 1);
    assert.match(skipRes.stderr, /SKIP \[claude\]/);

    const forceRes = runCli(['install', '--host', 'claude', '--force']);
    assert.equal(forceRes.status, 0, forceRes.stderr);
    assert.match(forceRes.stdout, /DONE \[claude\]/);

    // Antigravity defaults to real directory copy so symlink-skipping loaders discover SKILL.md
    mkdirSync(join(fakeHome, '.gemini'), { recursive: true });
    const agyRes = runCli(['install', '--host', 'antigravity']);
    assert.equal(agyRes.status, 0, agyRes.stderr);
    assert.match(agyRes.stdout, /DONE \[antigravity\] copied/);
    const agyDoc = JSON.parse(runCli(['--json', 'doctor']).stdout);
    assert.equal(agyDoc.hosts.find((h) => h.id === 'antigravity')?.status, 'copied');
    assert.ok(existsSync(join(fakeHome, '.gemini', 'config', 'skills', 'atelier-ui', 'SKILL.md')));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('check-ui.mjs supports --routes, --shots, --sheet, and catches overlap, emptyMedia, 404, and blank renders', async (t) => {
  const targets = buildCaptureTargets('http://127.0.0.1:4173/?frame=12', ['/', '/pricing'], ['S01', 'S02']);
  assert.equal(targets.length, 4);
  assert.equal(targets[0].url, 'http://127.0.0.1:4173/?frame=12&shot=S01');
  assert.equal(targets[3].url, 'http://127.0.0.1:4173/pricing?frame=12&shot=S02');

  const env = JSON.parse(runNode('scripts/detect-env.mjs').stdout);
  if (!env.tools.browserBinary || typeof WebSocket === 'undefined') {
    t.skip('No local Chrome/Edge binary or Node <22 WebSocket available');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'atelier-v2-test-'));
  try {
    const siteDir = join(dir, 'site');
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(
      join(siteDir, 'index.html'),
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Home</title><style>body{margin:0;background:#F6F4EF;color:#181715;font-family:system-ui,sans-serif;padding:40px}.hidden-panel{display:none}</style></head>
      <body><main><h1>Home Route</h1><p>Clean baseline route.</p><div class="hidden-panel"><svg width="24" height="24"></svg></div></main></body></html>`
    );
    mkdirSync(join(siteDir, 'pricing'), { recursive: true });
    writeFileSync(
      join(siteDir, 'pricing', 'index.html'),
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Pricing</title><style>body{margin:0;background:#F6F4EF;color:#181715;font-family:system-ui,sans-serif;padding:40px}</style></head>
      <body><main><h1>Pricing Route</h1><p>Second route checked deterministically.</p></main></body></html>`
    );

    const passRes = await runNodeAsync('scripts/check-ui.mjs', [
      siteDir,
      '--routes',
      '/,/pricing/',
      '--shots',
      'S01',
      '--ref',
      join(ROOT, 'docs', 'assets', 'nordhavn-desktop.png'),
      '--sheet',
      '--wait=80',
      '--out',
      join(dir, 'shots-pass'),
    ]);
    assert.equal(passRes.status, 0, `${passRes.stdout}\n${passRes.stderr}`);
    const passJson = JSON.parse(passRes.stdout);
    assert.equal(passJson.status, 'PASS');
    assert.equal(passJson.results.length, 4);
    assert.equal(passJson.sheets.length, 2);
    for (const s of passJson.sheets) {
      assert.ok(statSync(s).size > 0, `Expected non-empty comparison sheet at ${s}`);
    }

    const brokenHtml = join(dir, 'broken-v2.html');
    writeFileSync(
      brokenHtml,
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Broken V2</title>
      <link rel="stylesheet" href="/missing-styles.css" />
      <style>
        body { margin: 0; background: #ffffff; color: #111111; font-family: system-ui, sans-serif; }
        header { position: fixed; top: 0; left: 0; right: 0; height: 80px; background: #111111; color: #ffffff; z-index: 10; }
        h1 { margin: 10px 0 0 0; font-size: 32px; }
        #zero-canvas { width: 0; height: 0; display: block; }
      </style></head>
      <body>
        <header>Fixed Header</header>
        <main><h1>Covered Headline</h1><canvas id="zero-canvas"></canvas></main>
      </body></html>`
    );
    const failRes = await runNodeAsync('scripts/check-ui.mjs', [brokenHtml, '--wait=80', '--out', join(dir, 'shots-fail')]);
    assert.equal(failRes.status, 1, failRes.stdout);
    const failJson = JSON.parse(failRes.stdout);
    const f0 = failJson.results[0];
    assert.ok(f0.headerOverlaps.length >= 1, 'Expected headerOverlaps detection');
    assert.ok(f0.emptyMedia.length >= 1, 'Expected emptyMedia detection for 0px canvas');
    assert.ok(f0.failedRequests.some((r) => r.status === 404), 'Expected 404 detection in failedRequests');

    const blankHtml = join(dir, 'blank.html');
    writeFileSync(
      blankHtml,
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Blank</title>
      <style>html, body { margin: 0; width: 100%; height: 100%; background: #ffffff; }</style></head><body></body></html>`
    );
    const blankRes = await runNodeAsync('scripts/check-ui.mjs', [blankHtml, '--wait=50', '--out', join(dir, 'shots-blank')]);
    assert.equal(blankRes.status, 1, blankRes.stdout);
    const blankJson = JSON.parse(blankRes.stdout);
    assert.equal(blankJson.results[0].pixelSanity?.blankViewport, true, 'Expected blankViewport detection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
