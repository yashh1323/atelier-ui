#!/usr/bin/env node
/**
 * lint-ui.mjs — Clean, modular zero-dependency static slop & Craft Floor linter.
 * Scans one or more directories/files (.html, .css, .jsx, .tsx, .vue, .svelte, .astro).
 * Supports per-file ignores (atelier-disable-file id1 id2) and per-line ignores (atelier-disable id1 id2).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const TARGET_EXTS = new Set(['.html', '.css', '.jsx', '.tsx', '.vue', '.svelte', '.astro']);
const STYLE_EXTS = new Set(['.css', '.html', '.vue', '.svelte', '.astro']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.atelier']);

function extractDisableIds(text, marker) {
  const ids = new Set();
  const re = new RegExp(`${marker}\\s+([^\\n*>}]+)`, 'g');
  for (const m of text.matchAll(re)) {
    const chunk = m[1].split(/-->|\*\/|\*\}/)[0];
    for (const id of chunk.matchAll(/[\w-]+/g)) {
      ids.add(id[0]);
    }
  }
  return ids;
}

/** Mask multi-line comments and standalone // comments while preserving line count and https:// URLs. */
function stripCommentsPreserveLines(content, ext) {
  let masked = content.replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\r\n]/g, ' ')
  );
  if (ext !== '.css') {
    masked = masked.replace(/(^|[ \t])\/\/[^\r\n]*/g, (m, lead) => `${lead}${' '.repeat(m.length - lead.length)}`);
  }
  return masked;
}

const RULES = [
  {
    id: 'no-transition-all',
    severity: 'FAIL',
    exts: ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => /transition\s*:\s*all\b|transition-all\b/.test(line),
    msg: 'Avoid `transition: all` / `transition-all`. Animate explicit properties (transform, opacity).',
  },
  {
    id: 'no-100vw',
    severity: 'FAIL',
    exts: ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => /\b100vw\b|(?:^|[^\w-])w-screen(?![\w-])/.test(line),
    msg: 'Avoid `100vw` / `w-screen` (causes horizontal scrollbar overflow). Use `100%` / `w-full`.',
  },
  {
    id: 'no-outline-none',
    severity: 'FAIL',
    exts: ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line, ctx) => {
      if (/(?:focus-visible:outline-(?:none|0)\b)/.test(line)) {
        return !/focus-visible:(?:ring|border|shadow|bg|underline|outline-\[)/.test(line);
      }
      if (!/(outline\s*:\s*(none|0)\b|outline-none\b)/.test(line)) return false;
      if (/focus-visible/.test(line)) return false;
      return !ctx.hasFocusVisibleInFile;
    },
    msg: 'Do not suppress focus outlines without replacing them via `:focus-visible`.',
  },
  {
    id: 'no-placeholder-copy',
    severity: 'FAIL',
    exts: ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) =>
      /\b(lorem ipsum|dolor sit amet|acme(?:\s+(?:corp|inc|co))?|john doe|jane doe)\b/i.test(line) ||
      /\bTODO\b/.test(line),
    msg: 'Placeholder copy detected. Replace with real or domain-accurate copy.',
  },
  {
    id: 'no-generic-learn-more',
    severity: 'WARN',
    exts: ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => />\s*Learn [Mm]ore\s*</.test(line),
    msg: 'Generic "Learn more" CTA. Use concrete `<Verb> <Object>` labels instead.',
  },
  {
    id: 'no-purple-gradient-slop',
    severity: 'WARN',
    exts: ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) =>
      /(from-purple-|to-purple-|from-indigo-.*to-purple|from-violet-|#7c3aed.*#3b82f6|#3b82f6.*#7c3aed|#8b5cf6.*#6366f1)/i.test(
        line
      ),
    msg: 'Purple/indigo gradient detected. Ensure it is intentionally requested in the brief, not AI default.',
  },
  {
    id: 'no-gradient-text-slop',
    severity: 'WARN',
    exts: ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => /bg-clip-text|background-clip\s*:\s*text/.test(line),
    msg: 'Gradient text detected. Emphasis usually reads cleaner via scale, weight, and solid ink.',
  },
  {
    id: 'no-emoji-icons',
    severity: 'WARN',
    exts: ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => /<(button|a|h[1-6]|span)[^>]*>[\s]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line),
    msg: 'Emoji used as UI icon inside interactive/heading element. Use consistent crisp SVG icons.',
  },
  {
    id: 'no-middot-meta',
    severity: 'WARN',
    exts: ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
    test: (line) => /\S\s·\s\S/.test(line),
    msg: 'Middle-dot-joined meta string (`·`) detected. Use distinct elements, spacing, or crisp typographic hierarchy.',
  },
];

function collectFiles(target, seen = new Set(), out = []) {
  const abs = resolve(target);
  const st = statSync(abs);
  if (st.isFile()) {
    if (TARGET_EXTS.has(extname(abs)) && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }
  for (const entry of readdirSync(abs)) {
    if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) collectFiles(full, seen, out);
    else if (TARGET_EXTS.has(extname(full)) && !seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

function parseCliArgs(argv) {
  let jsonOut = false;
  const targets = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      console.log('Usage: node lint-ui.mjs [target-dir-or-file ...] [--json]');
      process.exit(0);
    }
    if (a === '--json') {
      jsonOut = true;
    } else if (a.startsWith('-')) {
      console.error(`lint-ui: unknown option "${a}". Usage: node lint-ui.mjs [target-dir-or-file ...] [--json]`);
      process.exit(2);
    } else {
      targets.push(a);
    }
  }
  return { jsonOut, targets: targets.length > 0 ? targets : ['.'] };
}

const { jsonOut, targets } = parseCliArgs(process.argv.slice(2));

const files = [];
const seenFiles = new Set();
for (const target of targets) {
  try {
    collectFiles(target, seenFiles, files);
  } catch (err) {
    console.error(`lint-ui: cannot scan "${target}": ${err.message}`);
    process.exit(2);
  }
}

const findings = [];
for (const file of files) {
  const rawContent = readFileSync(file, 'utf8');
  const ext = extname(file);
  const relFile = relative(process.cwd(), file);
  const fileDisabled = extractDisableIds(rawContent, 'atelier-disable-file');
  const rawLines = rawContent.split(/\r?\n/);
  const cleanContent = stripCommentsPreserveLines(rawContent, ext);
  const cleanLines = cleanContent.split(/\r?\n/);
  const ctx = { hasFocusVisibleInFile: STYLE_EXTS.has(ext) && /focus-visible/.test(cleanContent) };

  cleanLines.forEach((codeLine, idx) => {
    if (!codeLine.trim()) return;
    const lineDisabled = extractDisableIds(rawLines[idx], 'atelier-disable');
    for (const rule of RULES) {
      if (!rule.exts.includes(ext)) continue;
      if (fileDisabled.has(rule.id) || lineDisabled.has(rule.id)) continue;
      if (rule.test(codeLine, ctx)) {
        findings.push({
          file: relFile,
          line: idx + 1,
          rule: rule.id,
          severity: rule.severity,
          message: rule.msg,
        });
      }
    }
  });

  // File-level check: overflow-x: hidden directly on html/body root selectors
  if (STYLE_EXTS.has(ext) && !fileDisabled.has('no-overflow-x-hidden-root')) {
    const blocks =
      ext === '.css'
        ? [{ text: cleanContent, baseOffset: 0 }]
        : [...cleanContent.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => ({
            text: m[1],
            baseOffset: m.index + m[0].indexOf(m[1]),
          }));
    const hiddenRootRe = /(?:^|[\s,}])((?:html|body)(?:\s*,\s*(?:html|body))*)\s*\{[^}]*overflow-x\s*:\s*hidden/gi;
    for (const blk of blocks) {
      for (const m of blk.text.matchAll(hiddenRootRe)) {
        const leadLen = m[0].indexOf(m[1]);
        const absIndex = blk.baseOffset + m.index + leadLen;
        const startLine = rawContent.slice(0, absIndex).split(/\r?\n/).length;
        const endLine = rawContent.slice(0, absIndex + m[0].length).split(/\r?\n/).length;
        const snippet = rawLines.slice(Math.max(0, startLine - 2), endLine).join('\n');
        if (extractDisableIds(snippet, 'atelier-disable').has('no-overflow-x-hidden-root')) continue;
        findings.push({
          file: relFile,
          line: startLine,
          rule: 'no-overflow-x-hidden-root',
          severity: 'WARN',
          message: 'Prefer `overflow-x: clip` over `hidden` on html/body so position: sticky still works.',
        });
      }
    }
  }

  // File-level check: eyebrow kicker directly preceding <h1>
  if (ext !== '.css' && !fileDisabled.has('no-eyebrow-kicker')) {
    const kickerRe =
      /(?:<(p|span)\b[^>]*>(?=[^<\n]*\S)[^<\n]{1,90}<\/\1>|<div\b[^>]*class(?:Name)?=\{?["'`](?=[^"'`\n]*(?:eyebrow|kicker|overline|pill|badge))[^"'`\n]+["'`]\}?[^>]*>(?=[^<\n]*\S)[^<\n]{1,90}<\/div>)\s*<h1\b/gi;
    for (const m of cleanContent.matchAll(kickerRe)) {
      const startLine = rawContent.slice(0, m.index).split(/\r?\n/).length;
      const endLine = rawContent.slice(0, m.index + m[0].length).split(/\r?\n/).length;
      const snippet = rawLines.slice(Math.max(0, startLine - 2), endLine).join('\n');
      if (extractDisableIds(snippet, 'atelier-disable').has('no-eyebrow-kicker')) continue;
      findings.push({
        file: relFile,
        line: startLine,
        rule: 'no-eyebrow-kicker',
        severity: 'WARN',
        message: 'Eyebrow kicker directly preceding `<h1>`. Let the headline stand without an AI-formulaic kicker.',
      });
    }
  }

  // File-level check: @keyframes defined without prefers-reduced-motion
  if (STYLE_EXTS.has(ext) && /@keyframes\s+/.test(cleanContent) && !/prefers-reduced-motion/.test(cleanContent) && !fileDisabled.has('reduced-motion')) {
    findings.push({
      file: relFile,
      line: 1,
      rule: 'reduced-motion',
      severity: 'WARN',
      message: 'CSS defines @keyframes without a `@media (prefers-reduced-motion: reduce)` fallback.',
    });
  }
}

const fails = findings.filter((f) => f.severity === 'FAIL').length;
const warns = findings.filter((f) => f.severity === 'WARN').length;

if (jsonOut) {
  console.log(JSON.stringify({ filesScanned: files.length, fails, warns, findings }, null, 2));
} else {
  for (const f of findings) {
    console.log(`${f.severity} [${f.rule}] ${f.file}:${f.line} — ${f.message}`);
  }
  console.log(`\nlint-ui: scanned ${files.length} file(s) -> ${fails} FAIL, ${warns} WARN`);
}

process.exit(fails > 0 ? 1 : 0);
