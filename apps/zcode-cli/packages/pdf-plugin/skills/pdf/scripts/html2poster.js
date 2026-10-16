#!/usr/bin/env node
/**
 * html2poster.js — Single-page poster/long-image HTML → PDF converter
 *
 * Purpose: Convert a fixed-width, dynamic-height HTML poster into a single-page
 * vector PDF with zero margins. This script is PURPOSE-BUILT for posters and
 * infographics — it does NOT handle multi-page documents, A4 pagination, or
 * document-style margins. For those, use html2pdf-next.js.
 *
 * Usage:
 *   node html2poster.js poster.html
 *   node html2poster.js poster.html --output out.pdf
 *   node html2poster.js poster.html --width 720px
 *   node html2poster.js poster.html --width 720px --max-height 8000
 *
 * What it does (in order):
 *   1. Load HTML in Playwright
 *   2. Force overflow:hidden on .poster/.page containers (clip decorative overflow)
 *   3. Inject @page { margin: 0 } (override any existing margin)
 *   4. Ensure html/body have margin:0, padding:0, matching background
 *   5. Measure .poster scrollHeight (actual content height)
 *   6. Generate single-page PDF with exact dimensions
 *
 * What it does NOT do:
 *   - No pagination / page breaks
 *   - No A4 fallback
 *   - No margin injection (always zero)
 *   - No cover adaptation
 *   - No pdf-lib post-processing
 *   - No continuous-canvas detection
 *   - No vertical overflow expansion (posters WANT overflow:hidden)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── Playwright resolution ──

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch (_) {}
  }

  // Node never searches npm's global dir, and when node itself was installed
  // into a private prefix, playwright is usually installed right next to it.
  // Resolve both by hand instead of reporting "not installed".
  const Module = require('module');
  const roots = new Set();
  if (process.env.PLAYWRIGHT_PATH) roots.add(process.env.PLAYWRIGHT_PATH);
  if (process.env.NODE_PATH) {
    process.env.NODE_PATH.split(path.delimiter).filter(Boolean).forEach(p => roots.add(p));
  }
  // <prefix>/bin/node  ->  <prefix>/node_modules
  roots.add(path.join(path.dirname(process.execPath), '..', 'node_modules'));
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) roots.add(g);
  } catch (_) {}

  for (const base of roots) {
    for (const name of ['playwright', 'playwright-core']) {
      const dir = path.join(base, name);
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
      // Require by absolute path — createRequire() would still walk the
      // node_modules chain and miss roots not named node_modules.
      try { return Module.createRequire(__filename)(dir); } catch (_) {}
    }
  }
  return null;
}

// ── Chromium resolution (shared logic with html2pdf-next.js) ──

function resolveChromium(chromiumObj) {
  let exe;
  try { exe = chromiumObj.executablePath(); } catch (_) { exe = null; }
  if (exe && fs.existsSync(exe)) return { status: 'ok', executablePath: exe };

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ];
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) candidates.unshift(process.env.PLAYWRIGHT_CHROMIUM_PATH);

  for (const c of candidates) {
    if (fs.existsSync(c)) return { status: 'fallback', executablePath: c };
  }
  return { status: 'missing', executablePath: exe || '' };
}

// ── CLI parsing ──

function parseArgs(argv) {
  const tokens = argv.slice(2);
  let input = null, output = null, width = '720px', maxHeight = 16000;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--output' || t === '-o') output = tokens[++i];
    else if (t === '--width') width = tokens[++i];
    else if (t === '--max-height') maxHeight = parseInt(tokens[++i], 10);
    else if (t === '--help' || t === '-h') {
      console.log(`
Usage: node html2poster.js <input.html> [options]

Options:
  --output, -o    Output PDF path (default: input with .pdf extension)
  --width         Poster width (default: 720px)
  --max-height    Maximum allowed height in px (default: 16000, safety limit)
  -h, --help      Show this help
`);
      process.exit(0);
    }
    else if (!input) input = t;
    else if (!output) output = t;
  }

  if (!input) {
    console.error('Error: No input HTML file specified.');
    process.exit(1);
  }

  if (!output) {
    output = input.replace(/\.html?$/i, '.pdf');
    if (output === input) output = input + '.pdf';
  }

  return { input, output, width, maxHeight };
}

// ── Main ──

async function main() {
  const { input, output, width, maxHeight } = parseArgs(process.argv);
  const absIn = path.resolve(input);
  const absOut = path.resolve(output);

  if (!fs.existsSync(absIn)) {
    console.error(`Error: File not found: ${absIn}`);
    process.exit(1);
  }

  console.log(`\n🖼  html2poster — Single-page poster PDF generator`);
  console.log(`   Input:  ${absIn}`);
  console.log(`   Output: ${absOut}`);
  console.log(`   Width:  ${width}`);

  // Load Playwright
  const playwright = loadPlaywright();
  if (!playwright) {
    console.error('Error: playwright or playwright-core not installed.');
    console.error(`       Searched: require paths, PLAYWRIGHT_PATH, NODE_PATH,`);
    console.error(`                 ${path.join(path.dirname(process.execPath), '..', 'node_modules')}, npm root -g`);
    process.exit(1);
  }

  const { chromium } = playwright;
  const bInfo = resolveChromium(chromium);

  if (bInfo.status === 'missing') {
    console.error('Error: No Chromium found. Run: npx playwright install chromium');
    process.exit(1);
  }
  if (bInfo.status === 'fallback') {
    console.log(`   ⚠ Using fallback Chromium: ${bInfo.executablePath}`);
  }

  // Launch browser
  const launchOpts = { headless: true };
  if (bInfo.status === 'fallback') launchOpts.executablePath = bInfo.executablePath;

  const browser = await chromium.launch(launchOpts);

  try {
    // Use a wide viewport so content doesn't wrap unexpectedly
    const widthPx = parseInt(width, 10) || 720;
    const page = await browser.newPage({ viewport: { width: widthPx, height: 1200 } });

    await page.goto('file://' + absIn, { waitUntil: 'networkidle' });
    console.log(`\n   ✓ HTML loaded`);

    // ── Step 1: Force overflow:hidden on page containers ──
    // Decorative elements with negative offsets or width>100% inflate scrollWidth,
    // causing Playwright to shrink content to fit. overflow:hidden clips them.
    const overflowFixed = await page.evaluate(() => {
      const selectors = ['.poster', '.page', '#poster', '#page'];
      let fixed = 0;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const computed = getComputedStyle(el);
        if (computed.overflow !== 'hidden') {
          el.style.overflow = 'hidden';
          fixed++;
        }
      }
      return fixed;
    });
    if (overflowFixed > 0) {
      console.log(`   ✓ Added overflow:hidden to ${overflowFixed} container(s)`);
    }

    // ── Step 2: Inject @page { margin: 0 } — override any existing @page rule ──
    await page.evaluate(() => {
      const s = document.createElement('style');
      // Use !important-equivalent: place at end so it wins cascade
      s.textContent = `@page { margin: 0 !important; size: auto; }`;
      document.head.appendChild(s);
    });

    // ── Step 3: Ensure html/body have zero margin/padding ──
    const bgSync = await page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      html.style.margin = '0';
      html.style.padding = '0';
      body.style.margin = '0';
      body.style.padding = '0';

      // Sync body background with poster background to avoid color gaps
      const poster = document.querySelector('.poster') || document.querySelector('.page');
      if (poster) {
        const posterBg = getComputedStyle(poster).backgroundColor;
        if (posterBg && posterBg !== 'rgba(0, 0, 0, 0)' && posterBg !== 'transparent') {
          body.style.backgroundColor = posterBg;
          html.style.backgroundColor = posterBg;
          return posterBg;
        }
      }
      return null;
    });
    if (bgSync) {
      console.log(`   ✓ Synced body background: ${bgSync}`);
    }

    // ── Step 4: Measure actual content height ──
    const measurement = await page.evaluate(() => {
      const poster = document.querySelector('.poster') || document.querySelector('.page') || document.body;
      return {
        scrollHeight: poster.scrollHeight,
        scrollWidth: poster.scrollWidth,
        offsetWidth: poster.offsetWidth,
        selector: poster.className ? '.' + poster.className.split(' ')[0] : poster.tagName,
      };
    });

    console.log(`   ✓ Measured: ${measurement.selector} = ${measurement.scrollWidth}×${measurement.scrollHeight}px`);

    if (measurement.scrollWidth > widthPx + 2) {
      console.log(`   ⚠ WARNING: scrollWidth (${measurement.scrollWidth}px) > width (${widthPx}px)`);
      console.log(`     Decorative elements may still overflow. Check for position:absolute elements with negative offsets.`);
    }

    let contentHeight = measurement.scrollHeight;
    if (contentHeight > maxHeight) {
      console.log(`   ⚠ Content height ${contentHeight}px exceeds max ${maxHeight}px, clamping.`);
      contentHeight = maxHeight;
    }
    if (contentHeight < 100) {
      console.log(`   ⚠ Content height ${contentHeight}px seems too small, using 960px fallback.`);
      contentHeight = 960;
    }

    // ── Step 5: Generate PDF ──
    console.log(`\n   📄 Generating PDF: ${width} × ${contentHeight}px`);
    await page.pdf({
      path: absOut,
      width: width,
      height: contentHeight + 'px',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    console.log(`\n   ✅ Done: ${absOut}`);
    console.log(`      Size: ${(fs.statSync(absOut).size / 1024).toFixed(1)} KB`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`\n✗ Fatal: ${err.message}`);
  process.exit(1);
});

