#!/usr/bin/env node
/**
 * atelier-ui CLI — Cross-platform installer and environment doctor.
 * Zero external dependencies. Copies real skill files for hosts that skip
 * directory junctions/symlinks (such as Antigravity on Windows) or transient
 * npx caches, and symlinks/junctions otherwise (or when --link is passed).
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser } from '../scripts/detect-env.mjs';

const SKILL_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const COPY_ITEMS = ['SKILL.md', 'README.md', 'LICENSE', 'package.json', 'modules', 'library', 'scripts', 'bin'];

const HOSTS = {
  antigravity: {
    label: 'Antigravity',
    preferCopy: true,
    detect: () => existsSync(join(homedir(), '.gemini')),
    skillsDir: () => join(homedir(), '.gemini', 'config', 'skills'),
  },
  claude: {
    label: 'Claude Code',
    preferCopy: false,
    detect: () => existsSync(join(homedir(), '.claude')),
    skillsDir: () => join(homedir(), '.claude', 'skills'),
  },
  codex: {
    label: 'OpenAI Codex',
    preferCopy: false,
    detect: () => existsSync(join(homedir(), '.codex')),
    skillsDir: () => join(homedir(), '.codex', 'skills'),
  },
  cursor: {
    label: 'Cursor',
    preferCopy: false,
    detect: () => existsSync(join(homedir(), '.cursor')),
    skillsDir: () => join(homedir(), '.cursor', 'skills'),
  },
  opencode: {
    label: 'OpenCode',
    preferCopy: false,
    detect: () =>
      existsSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')),
    skillsDir: () =>
      join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'skills'),
  },
};

function readVersion(root = SKILL_ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isManagedCopy(targetPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(targetPath, 'package.json'), 'utf8'));
    return pkg?.name === 'atelier-ui' && existsSync(join(targetPath, 'SKILL.md'));
  } catch {
    return false;
  }
}

function copySkillFiles(dest) {
  mkdirSync(dest, { recursive: true });
  for (const item of COPY_ITEMS) {
    const src = join(SKILL_ROOT, item);
    if (existsSync(src)) {
      cpSync(src, join(dest, item), { recursive: true, force: true });
    }
  }
}

function printHelp() {
  console.log(`atelier-ui — install and verify the atelier-ui skill across coding agents

Usage:
  atelier-ui install [--host <name|all>] [--copy|--link] [--dry-run] [--force]
  atelier-ui update  [--host <name|all>] [--copy|--link] [--dry-run] [--force]
  atelier-ui doctor  [--json]
  atelier-ui version

Hosts:
  ${Object.keys(HOSTS).join(', ')}, all (default: all detected hosts)`);
}

function parseArgs(argv) {
  const out = { cmd: null, host: 'all', dryRun: false, force: false, json: false, mode: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.cmd = 'help';
      return out;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--copy') {
      out.mode = 'copy';
    } else if (a === '--link') {
      out.mode = 'link';
    } else if (a === '--host' || a.startsWith('--host=')) {
      const val = a === '--host' ? argv[++i] : a.slice(7);
      if (!val || (val !== 'all' && !HOSTS[val])) {
        console.error(`atelier-ui: unknown host "${val}". Expected all or one of: ${Object.keys(HOSTS).join(', ')}`);
        process.exit(2);
      }
      out.host = val;
    } else if (a.startsWith('-')) {
      console.error(`atelier-ui: unknown option "${a}"`);
      process.exit(2);
    } else if (!out.cmd) {
      out.cmd = a;
    } else {
      console.error(`atelier-ui: unexpected argument "${a}"`);
      process.exit(2);
    }
  }
  return out;
}

function sameFsPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inspectLink(targetPath) {
  if (!existsSync(targetPath)) {
    try {
      lstatSync(targetPath);
      return { status: 'broken-link', path: targetPath };
    } catch {
      return { status: 'not-installed', path: targetPath };
    }
  }
  const st = lstatSync(targetPath);
  const resolved = realpathSync(targetPath);
  const sameRoot = sameFsPath(resolved, SKILL_ROOT);
  if (st.isSymbolicLink()) {
    return { status: sameRoot ? 'linked' : 'external-link', path: targetPath, target: readlinkSync(targetPath) };
  }
  if (sameRoot) {
    return { status: 'linked', path: targetPath };
  }
  if (isManagedCopy(targetPath)) {
    return { status: 'copied', version: readVersion(targetPath), path: targetPath };
  }
  return { status: 'directory', path: targetPath };
}

function runDoctor(asJson) {
  const browser = findBrowser();
  const cdpSupported = typeof WebSocket !== 'undefined';
  const hosts = Object.entries(HOSTS).map(([id, cfg]) => {
    const detected = cfg.detect();
    const link = inspectLink(join(cfg.skillsDir(), 'atelier-ui'));
    return { id, label: cfg.label, detected, ...link };
  });
  const payload = {
    version: readVersion(),
    skillRoot: SKILL_ROOT,
    nodeVersion: process.version,
    cdpSupported,
    browserBinary: browser,
    hosts,
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  console.log(`atelier-ui v${payload.version} (${SKILL_ROOT})`);
  console.log(`Runtime: Node ${payload.nodeVersion} | CDP WebSocket: ${cdpSupported ? 'yes' : 'no (needs Node 22+)'} | Browser: ${browser || 'not found'}`);
  for (const h of hosts) {
    console.log(`  - ${h.label.padEnd(13)} detected=${String(h.detected).padEnd(5)} status=${h.status} (${h.path})`);
  }
  return 0;
}

function runInstall({ cmd, host, dryRun, force, mode }) {
  const selected =
    host === 'all'
      ? Object.entries(HOSTS).filter(([, cfg]) => cfg.detect())
      : [[host, HOSTS[host]]];

  if (selected.length === 0) {
    console.log('No supported agent host directories found (~/.gemini, ~/.claude, ~/.codex, ~/.cursor, ~/.config/opencode).');
    console.log('Specify `--host antigravity` (or claude/codex/cursor/opencode) to create one.');
    return 0;
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const isNpxCache = /[\\/]_npx[\\/]/.test(SKILL_ROOT);
  const currentVersion = readVersion();

  for (const [id, cfg] of selected) {
    const useCopy = mode === 'copy' ? true : mode === 'link' ? false : cfg.preferCopy || isNpxCache;
    const dir = cfg.skillsDir();
    const dest = join(dir, 'atelier-ui');
    const info = inspectLink(dest);

    if (!useCopy && info.status === 'linked') {
      console.log(`OK   [${id}] already linked -> ${dest}`);
      continue;
    }
    if (useCopy && info.status === 'copied' && cmd !== 'update' && !force && info.version === currentVersion) {
      console.log(`OK   [${id}] already installed (v${info.version}) -> ${dest}`);
      continue;
    }
    if ((info.status === 'directory' || info.status === 'external-link') && !force) {
      console.error(`SKIP [${id}] unmanaged existing path at ${dest} (pass --force to replace)`);
      process.exitCode = 1;
      continue;
    }
    if (dryRun) {
      console.log(useCopy ? `PLAN [${id}] copy ${SKILL_ROOT} -> ${dest}` : `PLAN [${id}] link ${SKILL_ROOT} -> ${dest} (${linkType})`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    if (info.status !== 'not-installed') {
      rmSync(dest, { recursive: true, force: true });
    }
    if (useCopy) {
      copySkillFiles(dest);
      console.log(`DONE [${id}] copied -> ${dest}`);
    } else {
      symlinkSync(SKILL_ROOT, dest, linkType);
      console.log(`DONE [${id}] linked -> ${dest}`);
    }
  }
  return process.exitCode || 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cmd || opts.cmd === 'help') {
    printHelp();
    process.exit(0);
  }
  if (opts.cmd === 'version') {
    console.log(readVersion());
    process.exit(0);
  }
  if (opts.cmd === 'doctor') {
    process.exit(runDoctor(opts.json));
  }
  if (opts.cmd === 'install' || opts.cmd === 'update') {
    process.exit(runInstall(opts));
  }
  console.error(`atelier-ui: unknown command "${opts.cmd}"`);
  printHelp();
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main();
}
