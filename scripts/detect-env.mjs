#!/usr/bin/env node
/**
 * detect-env.mjs — Zero-dependency environment and stack probe for atelier-ui.
 * Inspects the current working directory and available local CLI/browser tools
 * so the orchestrator never assumes pre-installed dependencies.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function cmdOnPath(cmd) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = spawnSync(probe, [cmd], { encoding: 'utf8' });
  return !res.error && res.status === 0;
}

function detectImpeccableCmd(cwd) {
  if (cmdOnPath('impeccable')) return 'impeccable';
  const localBin = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'impeccable.cmd' : 'impeccable');
  if (existsSync(localBin)) return 'npx --no-install impeccable';
  const homeBin = join(homedir(), '.impeccable', 'bin', process.platform === 'win32' ? 'impeccable.exe' : 'impeccable');
  if (existsSync(homeBin)) return `"${homeBin}"`;
  return null;
}

export function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH) && statSync(process.env.CHROME_PATH).isFile()) {
    return process.env.CHROME_PATH;
  }
  const home = homedir();
  const localApp = process.env.LOCALAPPDATA || '';
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          localApp ? join(localApp, 'Google\\Chrome\\Application\\chrome.exe') : '',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          localApp ? join(localApp, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          localApp ? join(localApp, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') : '',
        ].filter(Boolean)
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : [
          'google-chrome',
          'google-chrome-stable',
          'chromium',
          'chromium-browser',
          '/snap/bin/chromium',
          'microsoft-edge',
          'brave-browser',
        ];

  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else if (cmdOnPath(c)) {
      return c;
    }
  }
  return null;
}

function detectPackageManager(cwd, pkg) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  if (typeof pkg?.packageManager === 'string') {
    const pm = pkg.packageManager.split('@')[0].trim();
    if (['pnpm', 'yarn', 'bun', 'npm'].includes(pm)) return pm;
  }
  return 'npm';
}

export function detectProjectStack(cwd = process.cwd()) {
  const pkgPath = join(cwd, 'package.json');
  const stack = {
    hasPackageJson: existsSync(pkgPath),
    packageJsonValid: true,
    framework: 'static-html',
    packageManager: null,
    devCommand: null,
    tailwind: false,
    shadcn: existsSync(join(cwd, 'components.json')),
    threejs: false,
    hasProductMd: existsSync(join(cwd, 'PRODUCT.md')) || existsSync(join(cwd, 'product.md')),
    hasDesignMd: existsSync(join(cwd, 'DESIGN.md')) || existsSync(join(cwd, 'design.md')),
    hasAtelierBrief: existsSync(join(cwd, '.atelier', 'BRIEF.md')),
  };

  if (stack.hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) stack.framework = 'nextjs';
      else if (deps.astro) stack.framework = 'astro';
      else if (deps.svelte || deps['@sveltejs/kit']) stack.framework = 'svelte';
      else if (deps.vue || deps.nuxt) stack.framework = 'vue';
      else if (deps.react) stack.framework = 'react';
      else if (deps.vite) stack.framework = 'vite';
      else stack.framework = 'node-web';
      stack.tailwind = Boolean(deps.tailwindcss || deps['@tailwindcss/vite'] || deps['@tailwindcss/postcss']);
      stack.threejs = Boolean(deps.three || deps['@react-three/fiber']);
      const pm = detectPackageManager(cwd, pkg);
      stack.packageManager = pm;
      if (pkg.scripts?.dev) {
        stack.devCommand = pm === 'npm' ? 'npm run dev' : `${pm} dev`;
      }
    } catch {
      stack.packageJsonValid = false;
    }
  }
  return stack;
}

export function probeEnv(cwd = process.cwd()) {
  const impeccableCmd = detectImpeccableCmd(cwd);
  return {
    cwd,
    nodeVersion: process.version,
    platform: process.platform,
    project: detectProjectStack(cwd),
    tools: {
      agentBrowser: cmdOnPath('agent-browser'),
      impeccableCli: Boolean(impeccableCmd),
      impeccableCmd,
      browserBinary: findBrowser(),
      cdpSupported: typeof WebSocket !== 'undefined',
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  console.log(JSON.stringify(probeEnv(process.cwd()), null, 2));
}
