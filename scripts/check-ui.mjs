#!/usr/bin/env node
/**
 * check-ui.mjs — Zero-dependency headless Chrome/Edge CDP verifier for atelier-ui.
 * Evaluates layout, assets/fonts, contrast, blank/washed-out renders, and captures
 * desktop (1440x900), mobile (390x844), multi-route/shot captures, and --sheet collages.
 * Requires Node 22+ (native WebSocket) and Chrome, Edge, Chromium, or Brave locally.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBrowser } from './detect-env.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glsl': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function resolveSafeFile(root, entry, reqUrl) {
  let cleanUrl;
  try {
    cleanUrl = decodeURIComponent((reqUrl || '/').split('?')[0]);
  } catch {
    return { status: 400, cleanUrl: '', filePath: null };
  }
  const rel = cleanUrl.replace(/^\/+/, '');
  let filePath = cleanUrl === '/' ? entry : resolve(root, rel);
  const relToRoot = relative(root, filePath);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    return { status: 403, cleanUrl, filePath: null };
  }
  // Support clean static multi-page URLs (/pricing -> pricing.html or /pricing/ -> pricing/index.html)
  if ((!existsSync(filePath) || statSync(filePath).isDirectory()) && cleanUrl !== '/') {
    const dirIndex = resolve(filePath, 'index.html');
    const htmlCandidate = filePath.endsWith('.html') ? filePath : `${filePath}.html`;
    if (existsSync(dirIndex) && statSync(dirIndex).isFile()) {
      filePath = dirIndex;
    } else if (existsSync(htmlCandidate) && statSync(htmlCandidate).isFile()) {
      filePath = htmlCandidate;
    }
  }
  if (existsSync(filePath)) {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(filePath);
    const relReal = relative(realRoot, realFile);
    if (relReal.startsWith('..') || isAbsolute(relReal)) {
      return { status: 403, cleanUrl, filePath: null };
    }
  }
  return { status: 200, cleanUrl, filePath };
}

function startStaticServer(targetPath) {
  const abs = resolve(targetPath);
  const isDir = statSync(abs).isDirectory();
  const root = isDir ? abs : dirname(abs);
  const entry = isDir ? join(abs, 'index.html') : abs;
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    console.error(`check-ui: entry HTML file not found: ${entry}`);
    process.exit(2);
  }
  const server = createServer((req, res) => {
    const resolved = resolveSafeFile(root, entry, req.url);
    if (resolved.status !== 200) {
      res.writeHead(resolved.status);
      return res.end(resolved.status === 400 ? 'Bad request' : 'Forbidden');
    }
    const { cleanUrl, filePath } = resolved;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      if (cleanUrl === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` }))
  );
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
  }
  rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('WebSocket connection failed')), { once: true });
    });
    this.ws.addEventListener('close', () => this.rejectAll(new Error('CDP WebSocket closed')));
    this.ws.addEventListener('error', () => this.rejectAll(new Error('CDP WebSocket error')));
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].method === msg.method) {
            const w = this.waiters.splice(i, 1)[0];
            clearTimeout(w.timer);
            w.resolve(msg.params);
          }
        }
      }
    });
  }
  waitForEvent(method, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const entry = { method, resolve, timer: null };
      entry.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout calling ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

function parseListFlag(raw, flagName, usage) {
  if (!raw || raw.startsWith('-')) {
    console.error(`check-ui: ${flagName} requires a comma-separated list. ${usage}`);
    process.exit(2);
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    console.error(`check-ui: ${flagName} cannot be empty. ${usage}`);
    process.exit(2);
  }
  return items;
}

function parseCliArgs(argv) {
  const usage =
    'Usage: node check-ui.mjs <http-url-or-html-file-or-dir> [--out .atelier/shots] [--wait 900] [--full] [--allow-pending-anchors] [--routes /,/pricing] [--shots S01,S02] [--sheet] [--ref path.png]';
  let outDir = '.atelier/shots';
  let fullPage = false;
  let allowPendingAnchors = false;
  let sheet = false;
  let refPath = null;
  let waitMs = 900;
  let routes = [];
  let shots = [];
  const targets = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(usage);
      process.exit(0);
    } else if (a === '--full') {
      fullPage = true;
    } else if (a === '--allow-pending-anchors') {
      allowPendingAnchors = true;
    } else if (a === '--sheet') {
      sheet = true;
    } else if (a === '--out' || a.startsWith('--out=')) {
      const val = a === '--out' ? argv[++i] : a.slice(6);
      if (!val || val.startsWith('-')) {
        console.error(`check-ui: --out requires a directory path. ${usage}`);
        process.exit(2);
      }
      outDir = val;
    } else if (a === '--ref' || a.startsWith('--ref=')) {
      const val = a === '--ref' ? argv[++i] : a.slice(6);
      if (!val || val.startsWith('-')) {
        console.error(`check-ui: --ref requires an image file path. ${usage}`);
        process.exit(2);
      }
      refPath = resolve(val);
    } else if (a === '--routes' || a.startsWith('--routes=')) {
      const val = a === '--routes' ? argv[++i] : a.slice(9);
      routes = parseListFlag(val, '--routes', usage);
    } else if (a === '--shots' || a.startsWith('--shots=')) {
      const val = a === '--shots' ? argv[++i] : a.slice(8);
      shots = parseListFlag(val, '--shots', usage);
    } else if (a === '--wait' || a.startsWith('--wait=')) {
      const raw = a === '--wait' ? argv[++i] : a.slice(7);
      const val = raw && !raw.startsWith('-') ? Number(raw) : NaN;
      if (!Number.isFinite(val) || val < 0) {
        console.error(`check-ui: --wait requires a non-negative number of ms. ${usage}`);
        process.exit(2);
      }
      waitMs = val;
    } else if (a.startsWith('-')) {
      console.error(`check-ui: unknown option "${a}". ${usage}`);
      process.exit(2);
    } else {
      targets.push(a);
    }
  }

  if (targets.length !== 1) {
    console.error(usage);
    process.exit(2);
  }
  return {
    target: targets[0],
    outDir: resolve(outDir),
    fullPage,
    waitMs,
    allowPendingAnchors,
    routes,
    shots,
    sheet,
    refPath,
  };
}

function sanitizeSlug(label) {
  const clean = label.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return clean || 'home';
}

export function buildCaptureTargets(baseUrl, routes = [], shots = []) {
  const routeList = routes.length > 0 ? routes : [null];
  const shotList = shots.length > 0 ? shots : [null];
  const multi = routeList.length > 1 || shotList.length > 1;
  const out = [];
  for (const r of routeList) {
    for (const s of shotList) {
      const u = new URL(baseUrl);
      if (r !== null) {
        const cleanRoute = r.startsWith('/') ? r : `/${r}`;
        const parsedRoute = new URL(cleanRoute, u.origin);
        u.pathname = parsedRoute.pathname;
        for (const [k, v] of parsedRoute.searchParams.entries()) {
          u.searchParams.set(k, v);
        }
        if (parsedRoute.hash) u.hash = parsedRoute.hash;
      }
      if (s !== null) {
        u.searchParams.set('shot', s);
      }
      const parts = [];
      if (routes.length > 0) parts.push(sanitizeSlug(r));
      if (shots.length > 0) parts.push(sanitizeSlug(s));
      const suffix = multi && parts.length > 0 ? `__${parts.join('_')}` : '';
      out.push({
        label: parts.join(':') || 'default',
        suffix,
        url: u.toString(),
      });
    }
  }
  return out;
}

function formatConsoleError(e) {
  if (e.method === 'Runtime.consoleAPICalled') {
    const parts = (e.params?.args || []).map((a) => {
      if (a.value !== undefined) return String(a.value);
      return a.description || a.type || 'unknown';
    });
    return parts.join(' ') || 'console.error';
  }
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params?.exceptionDetails;
    return d?.exception?.description || d?.text || 'Uncaught exception';
  }
  return e.params?.entry?.text || 'console error';
}

function collectFailedRequests(events, pageUrl) {
  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {}
  const reqUrls = new Map();
  const reqTypes = new Map();
  const failures = [];
  const warnings = [];
  const seen = new Set();

  for (const e of events) {
    if (e.method === 'Network.requestWillBeSent') {
      const id = e.params?.requestId;
      if (id) {
        reqUrls.set(id, e.params.request?.url || '');
        reqTypes.set(id, e.params.type || 'Other');
      }
    } else if (e.method === 'Network.responseReceived') {
      const status = e.params?.response?.status || 0;
      const url = e.params?.response?.url || reqUrls.get(e.params?.requestId) || '';
      const type = e.params?.type || reqTypes.get(e.params?.requestId) || 'Other';
      if (status >= 400 && !url.endsWith('/favicon.ico')) {
        const key = `${status}:${url}`;
        if (!seen.has(key)) {
          seen.add(key);
          failures.push({ url, status, type });
        }
      }
    } else if (e.method === 'Network.loadingFailed') {
      const url = reqUrls.get(e.params?.requestId) || '';
      const type = e.params?.type || reqTypes.get(e.params?.requestId) || 'Other';
      const errText = e.params?.errorText || 'Failed to load';
      if (url && !url.endsWith('/favicon.ico') && !e.params?.canceled && errText !== 'net::ERR_ABORTED') {
        const key = `${errText}:${url}`;
        if (!seen.has(key)) {
          seen.add(key);
          let sameOrigin = false;
          try {
            sameOrigin = new URL(url).origin === pageOrigin;
          } catch {}
          if (sameOrigin || type === 'Script' || type === 'Image' || type === 'XHR' || type === 'Fetch') {
            failures.push({ url, error: errText, type });
          } else {
            warnings.push({ url, error: errText, type });
          }
        }
      }
    }
  }
  return { failedRequests: failures.slice(0, 15), networkWarnings: warnings.slice(0, 15) };
}

async function analyzeScreenshotPixels(cdp, base64Png) {
  const res = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${base64Png}";
      await img.decode();
      const w = 96, h = 64;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const n = w * h;
      const lums = new Float32Array(n);
      let sum = 0, minLum = 255, maxLum = 0;
      const r0 = data[0], g0 = data[1], b0 = data[2];
      let uniformCount = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lums[p] = lum;
        sum += lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) <= 6) uniformCount++;
      }
      const mean = sum / n;
      let varSum = 0;
      for (let p = 0; p < n; p++) {
        const d = lums[p] - mean;
        varSum += d * d;
      }
      const stdDev = Math.sqrt(varSum / n);
      const uniformRatio = uniformCount / n;
      return {
        uniformRatio: Number(uniformRatio.toFixed(3)),
        minLum: Number(minLum.toFixed(1)),
        maxLum: Number(maxLum.toFixed(1)),
        meanLum: Number(mean.toFixed(1)),
        stdDev: Number(stdDev.toFixed(1)),
        blankViewport: uniformRatio >= 0.985 && stdDev < 3.5,
      };
    })()`,
  });
  return res?.result?.value || null;
}

async function composeComparisonSheet(cdp, panels, outFile) {
  const validPanels = panels.filter((p) => p && existsSync(p.path));
  if (validPanels.length === 0) return null;

  const panelPayloads = validPanels.map((p) => {
    const mime = MIME[extname(p.path).toLowerCase()] || 'image/png';
    return {
      label: p.label,
      dataUri: `data:${mime};base64,${readFileSync(p.path).toString('base64')}`,
    };
  });

  const evalRes = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const items = ${JSON.stringify(panelPayloads)};
      const imgs = await Promise.all(items.map(async (it) => {
        const im = new Image();
        im.src = it.dataUri;
        await im.decode();
        return { label: it.label, im };
      }));
      const pad = 28;
      const headerH = 38;
      const targetH = 680;
      const dims = imgs.map(({ label, im }) => {
        const scale = Math.min(1, targetH / im.naturalHeight);
        const w = Math.max(120, Math.round(im.naturalWidth * scale));
        const h = Math.round(im.naturalHeight * scale);
        return { label, im, w, h };
      });
      const totalW = pad + dims.reduce((acc, d) => acc + d.w + pad, 0);
      const totalH = pad + headerH + Math.max(...dims.map((d) => d.h)) + pad;
      const canvas = document.createElement('canvas');
      canvas.width = totalW;
      canvas.height = totalH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#121316';
      ctx.fillRect(0, 0, totalW, totalH);
      let x = pad;
      for (const d of dims) {
        ctx.fillStyle = '#E5E7EB';
        ctx.font = '600 15px system-ui, -apple-system, sans-serif';
        ctx.fillText(d.label, x, pad + 22);
        ctx.strokeStyle = '#2E323B';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, pad + headerH - 1, d.w + 2, d.h + 2);
        ctx.drawImage(d.im, x, pad + headerH, d.w, d.h);
        x += d.w + pad;
      }
      return canvas.toDataURL('image/png').split(',')[1];
    })()`,
  });

  const b64 = evalRes?.result?.value;
  if (!b64) return null;
  writeFileSync(outFile, Buffer.from(b64, 'base64'));
  return outFile;
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createTcpServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 9222;
      srv.close(() => resolvePort(port));
    });
  });
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('check-ui: requires Node 22+ (native WebSocket).');
    process.exit(2);
  }

  const { target, outDir, fullPage, waitMs, allowPendingAnchors, routes, shots, sheet, refPath } =
    parseCliArgs(process.argv.slice(2));
  if (refPath && !existsSync(refPath)) {
    console.error(`check-ui: --ref file not found: ${refPath}`);
    process.exit(2);
  }

  const browserBin = findBrowser();
  if (!browserBin) {
    console.error('check-ui: Chrome/Edge/Chromium not found. Set CHROME_PATH or use agent-browser.');
    process.exit(2);
  }

  let staticSrv = null;
  let baseTargetUrl = target;
  if (!/^https?:\/\//i.test(target)) {
    const splitIdx = target.search(/[?#]/);
    const filePart = splitIdx === -1 ? target : target.slice(0, splitIdx);
    const suffix = splitIdx === -1 ? '' : target.slice(splitIdx);
    if (!existsSync(filePart)) {
      console.error(`check-ui: file not found: ${filePart}`);
      process.exit(2);
    }
    const srv = await startStaticServer(filePart);
    staticSrv = srv.server;
    baseTargetUrl = `${srv.url}${suffix}`;
  }

  const captureTargets = buildCaptureTargets(baseTargetUrl, routes, shots);
  mkdirSync(outDir, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'atelier-chrome-'));
  const cdpPort = await getFreePort();
  const gpuFlags =
    process.platform === 'linux'
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
      : ['--disable-gpu', '--enable-unsafe-swiftshader'];
  const chrome = spawn(
    browserBin,
    ['--headless=new', ...gpuFlags, '--no-first-run', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, 'about:blank'],
    { stdio: 'ignore' }
  );
  let spawnErr = null;
  chrome.on('error', (err) => {
    spawnErr = err;
  });

  let cdp = null;
  try {
    let wsUrl = null;
    for (let i = 0; i < 75; i++) {
      if (spawnErr) throw spawnErr;
      if (chrome.exitCode !== null) throw new Error(`Chrome exited prematurely with code ${chrome.exitCode}`);
      try {
        const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) throw new Error('Timed out waiting for Chrome DevTools Protocol');

    cdp = new CDP(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    const viewports = [
      { name: 'desktop-1440', width: 1440, height: 900 },
      { name: 'mobile-390', width: 390, height: 844 },
    ];

    const results = [];
    const sheets = [];

    for (const cap of captureTargets) {
      const capShots = [];
      for (const vp of viewports) {
        const blankLoad = cdp.waitForEvent('Page.loadEventFired', 2000);
        await cdp.send('Page.navigate', { url: 'about:blank' });
        await blankLoad;

        cdp.events.length = 0;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width,
          height: vp.height,
          deviceScaleFactor: 1,
          mobile: vp.width < 600,
        });
        const loadDone = cdp.waitForEvent('Page.loadEventFired', 8000);
        const navRes = await cdp.send('Page.navigate', { url: cap.url });
        await loadDone;
        if (navRes?.errorText) {
          results.push({
            target: cap.label,
            url: cap.url,
            viewport: vp.name,
            navigationError: navRes.errorText,
            overflowX: false,
            scrollWidth: 0,
            scrollHeight: 0,
            innerWidth: vp.width,
            brokenImgs: [],
            emptyMedia: [],
            headerOverlaps: [],
            tinyText: 0,
            h1Visible: false,
            deadLinks: [],
            lowContrast: [],
            failedRequests: [],
            fontSummary: { loadedCount: 0, failedCount: 0, families: [] },
            pixelSanity: null,
            consoleErrors: [navRes.errorText],
          });
          continue;
        }

        const evalRes = await cdp.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            const allowPending = ${JSON.stringify(allowPendingAnchors)};
            const postLoadWait = ${Math.round(waitMs)};
            if (document.readyState !== 'complete') {
              await Promise.race([
                new Promise(r => window.addEventListener('load', r, { once: true })),
                new Promise(r => setTimeout(r, 4000)),
              ]);
            }
            if (document.fonts?.ready) {
              await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 2000))]);
            }
            if ('__ATELIER_READY__' in window) {
              const deadline = Date.now() + 2500;
              while (window.__ATELIER_READY__ !== true && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 40));
              }
            }
            if (postLoadWait > 0) {
              await new Promise(r => setTimeout(r, postLoadWait));
            }

            const isVisuallyHidden = (el, st, rect) =>
              st.display === 'none' ||
              st.visibility === 'hidden' ||
              parseFloat(st.opacity) === 0 ||
              (rect.width <= 1 && rect.height <= 1) ||
              st.clip === 'rect(0px, 0px, 0px, 0px)' ||
              st.clipPath === 'inset(50%)';

            const overflowX = document.documentElement.scrollWidth > window.innerWidth;
            const brokenImgs = [...document.images]
              .filter(i => !i.complete || i.naturalWidth === 0)
              .map(i => i.src || i.alt || 'img');

            // Detect visible <canvas> or non-decorative <svg> with zero layout size (skip elements inside display:none ancestors)
            const emptyMedia = [];
            for (const el of document.querySelectorAll('canvas, svg')) {
              if (el.getClientRects().length === 0) continue;
              const st = getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
              if (el.tagName.toLowerCase() === 'svg' && el.getAttribute('aria-hidden') === 'true') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) {
                emptyMedia.push({ tag: el.tagName.toLowerCase(), id: el.id || null, w: rect.width, h: rect.height });
                if (emptyMedia.length >= 10) break;
              }
            }

            // Detect fixed/sticky header overlapping non-descendant h1 or primary hero buttons
            const headerOverlaps = [];
            const stickyBars = [...document.querySelectorAll('header, nav')].filter((el) => {
              const st = getComputedStyle(el);
              if (st.display === 'none' || st.visibility === 'hidden') return false;
              const pos = st.position;
              const r = el.getBoundingClientRect();
              return (pos === 'fixed' || pos === 'sticky') && r.height > 0 && r.width > 0;
            });
            const h1 = document.querySelector('h1');
            const h1Rect = h1 ? h1.getBoundingClientRect() : null;
            const h1Visible = h1Rect ? h1Rect.top < window.innerHeight && h1Rect.bottom > 0 : false;
            if (h1 && h1Rect && h1Rect.width > 0 && h1Rect.height > 0) {
              for (const bar of stickyBars) {
                if (bar.contains(h1) || h1.contains(bar)) continue;
                const br = bar.getBoundingClientRect();
                const ix = Math.max(0, Math.min(br.right, h1Rect.right) - Math.max(br.left, h1Rect.left));
                const iy = Math.max(0, Math.min(br.bottom, h1Rect.bottom) - Math.max(br.top, h1Rect.top));
                if (ix > 8 && iy > 6) {
                  headerOverlaps.push({ bar: bar.tagName.toLowerCase(), overlapPx: Math.round(iy) });
                }
              }
            }

            // Webfont inspection
            const loadedFamilies = new Set();
            let loadedFonts = 0;
            let failedFonts = 0;
            if (document.fonts) {
              for (const f of document.fonts) {
                if (f.status === 'loaded') {
                  loadedFonts++;
                  loadedFamilies.add(f.family.replace(/["']/g, ''));
                } else if (f.status === 'error') {
                  failedFonts++;
                }
              }
            }
            const fontSummary = {
              loadedCount: loadedFonts,
              failedCount: failedFonts,
              families: [...loadedFamilies].slice(0, 10),
              bodyFont: getComputedStyle(document.body).fontFamily,
              h1Font: h1 ? getComputedStyle(h1).fontFamily : null,
            };

            const tinyText = [...document.querySelectorAll('p, li, a, button, span')].filter(el => {
              const hasDirectText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
              if (!hasDirectText) return false;
              const st = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (isVisuallyHidden(el, st, rect)) return false;
              return parseFloat(st.fontSize) < 12;
            }).length;

            const deadLinks = [...document.querySelectorAll('a[href]')].filter(a => {
              const st = getComputedStyle(a);
              if (st.display === 'none' || st.visibility === 'hidden') return false;
              const raw = (a.getAttribute('href') || '').trim();
              if (raw === '#') return true;
              if (!raw.startsWith('#')) return false;
              let id = '';
              try { id = decodeURIComponent(raw.slice(1)); } catch { return true; }
              if (allowPending) return false;
              return id.length > 0 && !document.getElementById(id);
            }).map(a => ({ text: a.textContent.trim().slice(0, 40), href: a.getAttribute('href') })).slice(0, 15);

            const c2d = document.createElement('canvas');
            c2d.width = 1;
            c2d.height = 1;
            const ctx = c2d.getContext('2d', { willReadFrequently: true });
            const parseRgba = (s) => {
              if (!s || s === 'transparent') return [0, 0, 0, 0];
              const m = /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?\\s*\\)/i.exec(s);
              if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
              if (!ctx) return null;
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = '#000000';
              ctx.fillStyle = s;
              ctx.fillRect(0, 0, 1, 1);
              const d = ctx.getImageData(0, 0, 1, 1).data;
              return [d[0], d[1], d[2], d[3] / 255];
            };
            const blend = (fg, bg) => {
              const a = fg[3] + bg[3] * (1 - fg[3]);
              if (a <= 0) return [255, 255, 255, 1];
              return [
                (fg[0] * fg[3] + bg[0] * bg[3] * (1 - fg[3])) / a,
                (fg[1] * fg[3] + bg[1] * bg[3] * (1 - fg[3])) / a,
                (fg[2] * fg[3] + bg[2] * bg[3] * (1 - fg[3])) / a,
                a,
              ];
            };
            const inspectBg = (el) => {
              const chain = [];
              for (let cur = el; cur; cur = cur.parentElement) chain.push(cur);
              let nonRootOpaqueIdx = -1;
              for (let i = 0; i < chain.length; i++) {
                const cur = chain[i];
                const st = getComputedStyle(cur);
                if (st.backgroundImage !== 'none') return { skip: true };
                const c = parseRgba(st.backgroundColor);
                if (c && c[3] >= 0.99 && cur !== document.body && cur !== document.documentElement) {
                  nonRootOpaqueIdx = i;
                  break;
                }
              }
              const siblingBgs = [];
              if (nonRootOpaqueIdx === -1) {
                const r = el.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
                  for (const under of document.elementsFromPoint(cx, cy)) {
                    if (under === el || el.contains(under) || under.contains(el)) continue;
                    const ust = getComputedStyle(under);
                    const tag = under.tagName;
                    if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IMG' || ust.backgroundImage !== 'none') {
                      return { skip: true };
                    }
                    const uc = parseRgba(ust.backgroundColor);
                    if (uc && uc[3] > 0) siblingBgs.push(uc);
                    if (uc && uc[3] >= 0.99) break;
                  }
                }
              }
              let bg = [255, 255, 255, 1];
              for (let i = chain.length - 1; i >= 0; i--) {
                if (chain[i] !== document.documentElement && chain[i] !== document.body) continue;
                const c = parseRgba(getComputedStyle(chain[i]).backgroundColor);
                if (c && c[3] > 0) bg = blend(c, bg);
              }
              for (let i = siblingBgs.length - 1; i >= 0; i--) {
                bg = blend(siblingBgs[i], bg);
              }
              for (let i = chain.length - 1; i >= 0; i--) {
                if (chain[i] === document.documentElement || chain[i] === document.body) continue;
                const c = parseRgba(getComputedStyle(chain[i]).backgroundColor);
                if (c && c[3] > 0) bg = blend(c, bg);
              }
              return { skip: false, bg };
            };
            const lum = ([r, g, b]) => {
              const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
              return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            };
            const lowContrast = [];
            for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,a,button,label,th,td,span,time,figcaption')) {
              const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
              if (!text) continue;
              const st = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
              if (isVisuallyHidden(el, st, rect)) continue;
              const bgInfo = inspectBg(el);
              if (bgInfo.skip) continue;
              const fgRaw = parseRgba(st.color);
              if (!fgRaw || fgRaw[3] === 0) continue;
              const bg = bgInfo.bg;
              const fg = fgRaw[3] < 1 ? blend(fgRaw, bg) : fgRaw;
              const l1 = lum(fg), l2 = lum(bg);
              const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
              const fs = parseFloat(st.fontSize), fw = parseInt(st.fontWeight, 10) || 400;
              const required = (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3.0 : 4.5;
              if (ratio < required) {
                lowContrast.push({ text: text.slice(0, 40), ratio: Number(ratio.toFixed(2)), required });
                if (lowContrast.length >= 15) break;
              }
            }

            return {
              overflowX,
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
              innerWidth: window.innerWidth,
              brokenImgs,
              emptyMedia,
              headerOverlaps,
              tinyText,
              h1Visible,
              deadLinks,
              lowContrast,
              fontSummary,
            };
          })()`,
        });

        const metrics = evalRes?.result?.value;
        if (!metrics) {
          const desc = evalRes?.exceptionDetails?.exception?.description || 'Runtime evaluation failed';
          results.push({
            target: cap.label,
            url: cap.url,
            viewport: vp.name,
            evaluationError: desc,
            overflowX: false,
            scrollWidth: 0,
            scrollHeight: 0,
            innerWidth: vp.width,
            brokenImgs: [],
            emptyMedia: [],
            headerOverlaps: [],
            tinyText: 0,
            h1Visible: false,
            deadLinks: [],
            lowContrast: [],
            failedRequests: [],
            fontSummary: { loadedCount: 0, failedCount: 0, families: [] },
            pixelSanity: null,
            consoleErrors: [desc],
          });
          continue;
        }

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const shotPath = join(outDir, `${vp.name}${cap.suffix}.png`);
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        capShots.push({ label: `${cap.label} · ${vp.width}×${vp.height}`, path: shotPath });

        let fullShotPath;
        if (fullPage) {
          const fullShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          fullShotPath = join(outDir, `${vp.name}${cap.suffix}-full.png`);
          writeFileSync(fullShotPath, Buffer.from(fullShot.data, 'base64'));
        }

        const { failedRequests, networkWarnings } = collectFailedRequests(cdp.events, cap.url);
        const consoleErrors = cdp.events
          .filter(
            (e) =>
              e.method === 'Runtime.exceptionThrown' ||
              (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error') ||
              (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
          )
          .map(formatConsoleError);

        // Evaluate pixel sanity on about:blank so target-site CSP never blocks data:image/png decoding
        const postBlank = cdp.waitForEvent('Page.loadEventFired', 2000);
        await cdp.send('Page.navigate', { url: 'about:blank' });
        await postBlank;
        const pixelSanity = await analyzeScreenshotPixels(cdp, shot.data);

        results.push({
          target: cap.label,
          url: cap.url,
          viewport: vp.name,
          ...metrics,
          failedRequests,
          ...(networkWarnings.length ? { networkWarnings } : {}),
          pixelSanity,
          consoleErrors,
          screenshot: shotPath,
          ...(fullShotPath ? { fullScreenshot: fullShotPath } : {}),
        });
      }

      if (sheet && capShots.length > 0) {
        const panels = refPath ? [{ label: 'REFERENCE', path: refPath }, ...capShots] : capShots;
        const sheetPath = join(outDir, `review-sheet${cap.suffix}.png`);
        const composed = await composeComparisonSheet(cdp, panels, sheetPath);
        if (composed) sheets.push(composed);
      }
    }

    let hasFail = false;
    for (const r of results) {
      const hasOfflineFontWarning = Boolean(r.networkWarnings?.some((w) => w.type === 'Font'));
      if (
        r.navigationError ||
        r.evaluationError ||
        r.overflowX ||
        r.brokenImgs.length > 0 ||
        r.emptyMedia.length > 0 ||
        r.headerOverlaps.length > 0 ||
        r.failedRequests.length > 0 ||
        (r.fontSummary?.failedCount > 0 && !hasOfflineFontWarning) ||
        r.pixelSanity?.blankViewport ||
        r.consoleErrors.length > 0 ||
        r.deadLinks.length > 0 ||
        r.lowContrast.length > 0 ||
        r.tinyText > 0
      ) {
        hasFail = true;
      }
    }
    console.log(JSON.stringify({ status: hasFail ? 'FAIL' : 'PASS', results, ...(sheets.length ? { sheets } : {}) }, null, 2));
    process.exitCode = hasFail ? 1 : 0;
  } finally {
    try { cdp?.close(); } catch {}
    try {
      if (chrome.exitCode === null) {
        chrome.kill();
        await Promise.race([
          new Promise((r) => chrome.once('exit', r)),
          new Promise((r) => setTimeout(r, 600)),
        ]);
      }
    } catch {}
    try { staticSrv?.close(); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main();
}
