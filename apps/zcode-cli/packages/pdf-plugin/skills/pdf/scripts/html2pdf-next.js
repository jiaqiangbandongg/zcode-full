#!/usr/bin/env node
/**
 * html2pdf-next.js — HTML → PDF converter using Playwright + pdf-lib
 *
 * Drop-in replacement for html2pdf.js, WITHOUT Paged.js dependency.
 * Uses Chromium native @page CSS for pagination + pdf-lib for post-processing.
 *
 * Usage:
 *   node html2pdf-next.js input.html
 *   node html2pdf-next.js input.html --output result.pdf
 *   node html2pdf-next.js input.html --css extra.css
 *   node html2pdf-next.js input.html --width 720px --height 960px
 *   node html2pdf-next.js input.html --direct   (same as default now — no Paged.js to skip)
 *   node html2pdf-next.js input.html --merge a.pdf b.pdf  (merge additional PDFs after)
 *
 * Architecture:
 *   1. Playwright renders HTML → raw PDF via Chromium's native print engine
 *   2. Pre-render hooks: Mermaid, KaTeX, oversized element fixes
 *   3. Post-render: pdf-lib for merge, metadata, page count extraction
 *   4. No Paged.js, no paged.polyfill.js — CSS @page handles pagination natively
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// Playwright / Chromium resolution (self-contained, no external helper)
// ═══════════════════════════════════════════════════════════════════

function loadPlaywright() {
  // Try direct require first
  try { return require('playwright'); } catch (_) {}

  // Search common global paths
  const Module = require('module');
  const roots = new Set();
  if (process.env.PLAYWRIGHT_PATH) roots.add(process.env.PLAYWRIGHT_PATH);
  if (process.env.NODE_PATH) {
    process.env.NODE_PATH.split(path.delimiter).filter(Boolean).forEach(p => roots.add(p));
  }
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) roots.add(g);
  } catch (_) {}

  for (const base of roots) {
    const pkg = path.join(base, 'playwright', 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try { return Module.createRequire(pkg)('playwright'); } catch (_) {}
  }
  throw new Error('Playwright not found. Install: npm install -g playwright');
}

function loadPdfLib() {
  try { return require('pdf-lib'); } catch (_) {}
  const Module = require('module');
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pkg = path.join(g, 'pdf-lib', 'package.json');
    if (fs.existsSync(pkg)) return Module.createRequire(pkg)('pdf-lib');
  } catch (_) {}
  throw new Error('pdf-lib not found. Install: npm install -g pdf-lib');
}

function resolveChromium(chromiumObj, allowInstall = false) {
  let exe;
  try { exe = chromiumObj.executablePath(); } catch (_) { exe = null; }

  if (exe && fs.existsSync(exe)) {
    return { status: 'ok', executablePath: exe };
  }

  // Try system Chrome/Chromium
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ];
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) candidates.unshift(process.env.PLAYWRIGHT_CHROMIUM_PATH);

  for (const c of candidates) {
    if (fs.existsSync(c)) return { status: 'fallback', executablePath: c };
  }

  if (allowInstall) {
    const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: true });
    if (r.status === 0) {
      try { exe = chromiumObj.executablePath(); } catch (_) {}
      if (exe && fs.existsSync(exe)) return { status: 'installed', executablePath: exe };
    }
  }

  return { status: 'missing', executablePath: exe || '' };
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function cli() {
  const tokens = process.argv.slice(2);
  if (!tokens.length || tokens[0] === '-h' || tokens[0] === '--help') {
    console.log(`
Usage: node html2pdf-next.js <input.html> [options]

Options:
  --output, -o <file>   Output PDF path (default: <input>.pdf)
  --css <file>          Inject extra stylesheet
  --width <px>          Custom page width  (e.g. 720px)
  --height <px>         Custom page height (e.g. 960px)
  --direct              (no-op, kept for backward compat — always direct now)
  --merge <files...>    Append additional PDF files after conversion
  --title <text>        Set PDF document title metadata
  --help, -h            Show help
`);
    process.exit(0);
  }

  const inputFile = tokens[0];
  let outputFile = null, customCSS = null, width = null, height = null;
  let mergeFiles = [], title = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--output' || t === '-o') outputFile = tokens[++i];
    else if (t === '--css') customCSS = tokens[++i];
    else if (t === '--width') width = tokens[++i];
    else if (t === '--height') height = tokens[++i];
    else if (t === '--direct') { /* no-op, always direct */ }
    else if (t === '--title') title = tokens[++i];
    else if (t === '--merge') {
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        mergeFiles.push(tokens[++i]);
      }
    }
  }

  if (!outputFile) {
    const p = path.parse(inputFile);
    outputFile = path.join(p.dir || '.', p.name + '.pdf');
  }

  return { inputFile, outputFile, customCSS, width, height, mergeFiles, title };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function prettyBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toFixed(1)} ${units[u]}`;
}

// ═══════════════════════════════════════════════════════════════════
// Pre-render hooks (run in browser context before PDF export)
// ═══════════════════════════════════════════════════════════════════

async function preRenderHooks(page) {
  const warnings = [];

  // 1. Wait for Mermaid diagrams
  const hasMermaid = await page.evaluate(() => document.querySelectorAll('.mermaid').length > 0);
  if (hasMermaid) {
    console.log('  ⏳ Waiting for Mermaid diagrams...');
    try {
      await page.waitForFunction(() => {
        for (const m of document.querySelectorAll('.mermaid'))
          if (!m.querySelector('svg') && !m.getAttribute('data-processed')) return false;
        return true;
      }, { timeout: 30000 });
      await sleep(2000);
      console.log('  ✓ Mermaid rendered');
    } catch (_) {
      warnings.push('Mermaid rendering timed out (30s)');
    }
  }

  // 2. Trigger KaTeX math rendering
  const katexStatus = await page.evaluate(() => ({
    lib: typeof renderMathInElement === 'function' || typeof katex !== 'undefined',
    rendered: document.querySelectorAll('.katex').length > 0,
    raw: /\$[^$]+\$|\$\$[^$]+\$\$|\\\(.*?\\\)|\\\[.*?\\\]/.test(document.body.innerText),
  }));

  // Auto-inject KaTeX CDN if raw math detected but library not loaded
  if (!katexStatus.lib && katexStatus.raw && !katexStatus.rendered) {
    console.log('  ⏳ Auto-injecting KaTeX CDN (math formulas detected but KaTeX not loaded)...');
    await page.addStyleTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js' });
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js' });
    await sleep(2000); // Wait for CDN scripts to load
    // Re-check
    const recheckLib = await page.evaluate(() => typeof renderMathInElement === 'function');
    if (recheckLib) {
      console.log('  ✓ KaTeX CDN loaded successfully');
    } else {
      console.log('  ⚠ KaTeX CDN failed to load — math will render as raw text');
      warnings.push('KaTeX CDN injection failed; math formulas may appear as raw LaTeX code');
    }
  }

  // Re-evaluate after potential CDN injection
  const katexReady = await page.evaluate(() => ({
    lib: typeof renderMathInElement === 'function' || typeof katex !== 'undefined',
    rendered: document.querySelectorAll('.katex').length > 0,
    raw: /\$[^$]+\$|\$\$[^$]+\$\$|\\\(.*?\\\)|\\\[.*?\\\]/.test(document.body.innerText),
  }));

  if (katexReady.lib && !katexReady.rendered && katexReady.raw) {
    console.log('  ⏳ Triggering KaTeX rendering...');
    await page.evaluate(() => {
      if (typeof renderMathInElement === 'function')
        renderMathInElement(document.body, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
    });
    await sleep(1000);
    console.log('  ✓ KaTeX rendered');
  } else if (katexReady.rendered) {
    await sleep(500); // Font loading settle
  }

  // 3. Fix oversized elements that prevent page breaks
  const nFixed = await page.evaluate(() => {
    const LIMIT = 1000;
    let n = 0;
    document.querySelectorAll(
      '[style*="page-break-inside: avoid"],[style*="break-inside: avoid"],' +
      '.avoid-break,table,figure,.theorem,.algorithm'
    ).forEach(el => {
      if (el.getBoundingClientRect().height > LIMIT) {
        el.style.pageBreakInside = 'auto';
        el.style.breakInside = 'auto';
        n++;
      }
    });
    return n;
  });
  if (nFixed) {
    console.log(`  ⚠ Fixed ${nFixed} oversized elements (removed break-inside: avoid)`);
  }

  // 4. Detect overflow (horizontal AND vertical)
  const overflows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('pre,table,figure,img,svg,.mermaid,blockquote,.equation').forEach(el => {
      const hDiff = el.scrollWidth - el.clientWidth;
      const vDiff = el.scrollHeight - el.clientHeight;
      if (hDiff > 2 || vDiff > 2) out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || '',
        hOverflow: hDiff > 2 ? hDiff : 0,
        vOverflow: vDiff > 2 ? vDiff : 0,
        preview: (el.textContent || '').slice(0, 50).replace(/\s+/g, ' '),
      });
    });
    return out;
  });
  if (overflows.length) {
    console.log('  ⚠ Overflow detected:');
    overflows.forEach(o => {
      const parts = [];
      if (o.hOverflow) parts.push(`H +${o.hOverflow}px`);
      if (o.vOverflow) parts.push(`V +${o.vOverflow}px`);
      console.log(`    <${o.tag}${o.cls ? '.' + o.cls.split(' ')[0] : ''}> ${parts.join(', ')}`);
    });
    warnings.push(`${overflows.length} element(s) have overflow`);
  }

  // 4b. Fix vertical overflow on page-level containers
  //     When html/body or the main content canvas has a fixed height + overflow:hidden,
  //     content gets clipped. For documents (html2pdf-next.js), we DON'T expand the
  //     container to its scrollHeight — that creates an oversized single "page" that
  //     Playwright splits unevenly. Instead, we remove the fixed height and overflow:hidden
  //     so content flows naturally and @page CSS handles pagination.
  //
  //     (The old "expand to scrollHeight" logic belongs in html2poster.js where a single
  //     continuous canvas is the desired output.)
  const vOverflowFix = await page.evaluate(() => {
    const fixes = [];
    // Candidates: html, body, and any direct child of body that acts as a full-page canvas
    const candidates = [document.documentElement, document.body];
    const bodyChildren = document.body.children;
    for (let i = 0; i < bodyChildren.length; i++) {
      const child = bodyChildren[i];
      // Skip SVG defs, script, style elements
      const tag = child.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'link') continue;
      candidates.push(child);
      // Also check one level deeper (e.g., .canvas > .content)
      for (let j = 0; j < child.children.length; j++) {
        const grandchild = child.children[j];
        const gtag = grandchild.tagName.toLowerCase();
        if (gtag === 'svg' || gtag === 'script' || gtag === 'style') continue;
        candidates.push(grandchild);
      }
    }

    for (const el of candidates) {
      const computed = getComputedStyle(el);
      const overflow = computed.overflow || computed.overflowY;
      const hasHiddenOverflow = overflow === 'hidden' || overflow === 'clip';
      const diff = el.scrollHeight - el.clientHeight;

      if (hasHiddenOverflow && diff > 5) {
        // This element is clipping content vertically
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
        const selector = `${tag}${id}${cls}`;

        const oldHeight = el.clientHeight;

        // Document mode: remove fixed height + overflow:hidden,
        // let @page handle natural pagination
        el.style.height = 'auto';
        el.style.minHeight = 'auto';
        el.style.maxHeight = 'none';
        el.style.overflow = 'visible';
        el.style.overflowY = 'visible';

        fixes.push({
          selector,
          oldHeight,
          clipped: diff,
        });
      }
    }

    // After fixing containers, re-measure to get the final content height
    const finalHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );

    return { fixes, finalHeight };
  });

  if (vOverflowFix.fixes.length) {
    console.log('  ⚠️  Removed fixed height + overflow:hidden — content will paginate naturally:');
    vOverflowFix.fixes.forEach(f => {
      console.log(`    ${f.selector}: was ${f.oldHeight}px with ${f.clipped}px clipped → now auto (content will flow to next page)`);
    });
  }

  // 4c. Convert absolute-bottom elements to document flow
  //     Elements with `position: absolute; bottom: Npx` inside page containers
  //     are pinned relative to their containing block. When content paginates
  //     across multiple @page pages, these elements either overlap with body
  //     text or land on the wrong page. Fix: convert them to static positioning
  //     so they participate in normal document flow and paginate naturally.
  const absBottomFix = await page.evaluate(() => {
    const converted = [];
    // Scan inside page-level containers (body children and their children)
    const containers = [];
    for (let i = 0; i < document.body.children.length; i++) {
      const child = document.body.children[i];
      const tag = child.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'link') continue;
      containers.push(child);
    }

    for (const container of containers) {
      const descendants = container.querySelectorAll('*');
      for (const el of descendants) {
        const computed = getComputedStyle(el);
        if (computed.position === 'absolute' && computed.bottom !== 'auto' && computed.bottom !== '') {
          // Check if this element contains visible text (not just decorative)
          const hasText = el.textContent && el.textContent.trim().length > 0;
          if (!hasText) continue;

          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
          const selector = `${tag}${id}${cls}`;

          // Convert to static flow: remove absolute positioning
          el.style.position = 'static';
          el.style.bottom = 'auto';
          el.style.left = 'auto';
          el.style.right = 'auto';
          // Preserve horizontal padding/margin from the original left/right values
          // by keeping any existing padding or margin on the element

          converted.push({ selector, bottom: computed.bottom });
        }
      }
    }
    return converted;
  });

  if (absBottomFix.length) {
    console.log('  ⚠️  Converted absolute-bottom elements to document flow (prevents overlap on multi-page):');
    absBottomFix.forEach(f => {
      console.log(`    ${f.selector}: was position:absolute;bottom:${f.bottom} → now static (flows with content)`);
    });
  }

  // 5. Inject minimal @page CSS fallback
  await page.evaluate(() => {
    const styles = Array.from(document.querySelectorAll('style'));
    const hasPageRule = styles.some(s => (s.textContent || '').includes('@page'));
    if (!hasPageRule) {
      const s = document.createElement('style');
      s.textContent = `@page { margin: 20mm; }`;
      document.head.appendChild(s);
    }
  });

  // 6. Fix full-page cover sections for print
  //    In screen mode, height:100vh = viewport height. In print mode, 100vh ≠ page height.
  //    Detect elements using 100vh and convert to print-safe page-filling behavior.
  const coverFixed = await page.evaluate(() => {
    let fixed = 0;
    // Find elements with height: 100vh (inline or computed)
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const style = el.style;
      const computed = getComputedStyle(el);
      const isVh = style.height === '100vh' || computed.height === '100vh' ||
                   style.minHeight === '100vh' || computed.minHeight === '100vh';
      // Also detect via class name hints
      const isCover = el.classList.contains('cover') || el.classList.contains('cover-page') ||
                      el.id === 'cover' || el.getAttribute('data-role') === 'cover';
      if (isVh || (isCover && el.offsetHeight > 0)) {
        // Force the element to fill the print page
        el.style.height = '100vh';
        el.style.minHeight = '100vh';
        el.style.pageBreakAfter = 'always';
        el.style.pageBreakInside = 'avoid';
        el.style.boxSizing = 'border-box';
        el.style.overflow = 'hidden';
        fixed++;
      }
    }
    // Inject print-specific CSS to make 100vh work correctly
    if (fixed > 0) {
      const s = document.createElement('style');
      s.textContent = `
        @media print {
          .cover, .cover-page, [data-role="cover"] {
            height: 100vh !important;
            min-height: 100vh !important;
            page-break-after: always !important;
            page-break-inside: avoid !important;
            overflow: hidden !important;
          }
        }
      `;
      document.head.appendChild(s);
    }
    return fixed;
  });
  if (coverFixed) {
    console.log(`  ✓ Fixed ${coverFixed} full-page cover section(s) for print`);
    // Also inject named @page rule for cover with zero margins
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.textContent = `
        @page cover-page {
          margin: 0 !important;
        }
        @media print {
          .cover, .cover-page, [data-role="cover"] {
            page: cover-page;
            margin: 0 !important;
            padding: 40px !important;
          }
        }
      `;
      document.head.appendChild(s);
    });
  }

  return { warnings, contentHeight: vOverflowFix.finalHeight };
}

// ═══════════════════════════════════════════════════════════════════
// Content statistics (post-render, from PDF or page)
// ═══════════════════════════════════════════════════════════════════

async function collectStats(page) {
  return page.evaluate(() => {
    const body = document.body;
    const text = body.innerText || '';
    const zhChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enWords = (text.match(/[a-zA-Z]+/g) || []).length;
    return {
      wordCount: zhChars + enWords,
      figures: document.querySelectorAll('figure,.figure,img').length,
      tables: document.querySelectorAll('table').length,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════
// pdf-lib post-processing: page count, metadata, merge
// ═══════════════════════════════════════════════════════════════════

async function postProcess(pdfPath, options = {}) {
  const { PDFDocument } = loadPdfLib();
  const pdfBytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(pdfBytes);

  // Set metadata
  if (options.title) doc.setTitle(options.title);
  doc.setProducer('html2pdf-next (Playwright + pdf-lib)');
  doc.setCreationDate(new Date());

  const pageCount = doc.getPageCount();

  // Merge additional PDFs
  if (options.mergeFiles && options.mergeFiles.length) {
    for (const mf of options.mergeFiles) {
      if (!fs.existsSync(mf)) {
        console.log(`  ⚠ Merge file not found: ${mf}`);
        continue;
      }
      console.log(`  📎 Merging: ${path.basename(mf)}`);
      const donorBytes = fs.readFileSync(mf);
      const donorDoc = await PDFDocument.load(donorBytes);
      const copiedPages = await doc.copyPages(donorDoc, donorDoc.getPageIndices());
      copiedPages.forEach(p => doc.addPage(p));
    }
  }

  // Save
  const finalBytes = await doc.save();
  fs.writeFileSync(pdfPath, finalBytes);

  return { pageCount: doc.getPageCount(), originalPages: pageCount };
}

// ═══════════════════════════════════════════════════════════════════
// Main pipeline
// ═══════════════════════════════════════════════════════════════════

async function convert(inputFile, outputFile, customCSS, options = {}) {
  const { width, height, mergeFiles, title } = options;

  if (!fs.existsSync(inputFile)) {
    console.error(`✗ File not found: ${inputFile}`);
    process.exit(1);
  }

  const playwright = loadPlaywright();
  const { chromium } = playwright;

  // Resolve browser
  const canInstall = process.env.PDF_SKIP_BROWSER_INSTALL !== '1';
  const bInfo = resolveChromium(chromium, canInstall);

  if (bInfo.status === 'missing') {
    console.error('\n✗ Chromium not found. Run: npx playwright install chromium\n');
    process.exit(2);
  }
  if (bInfo.status === 'fallback') {
    console.log(`⚠ Using fallback Chromium: ${bInfo.executablePath}`);
  }

  const absIn = path.resolve(inputFile);
  const absOut = path.resolve(outputFile);

  console.log(`\n🔄 Converting ${path.basename(inputFile)}...`);
  console.log(`   Engine: Playwright + Chromium native @page (no Paged.js)`);

  // Read and optionally inject CSS
  let html = fs.readFileSync(absIn, 'utf-8');
  if (customCSS) {
    if (!fs.existsSync(customCSS)) {
      console.error(`✗ CSS file not found: ${customCSS}`);
      process.exit(1);
    }
    const tag = `<style>${fs.readFileSync(customCSS, 'utf-8')}</style>`;
    html = html.includes('</head>') ? html.replace('</head>', tag + '\n</head>') : tag + '\n' + html;
    // Write modified HTML for Playwright to load
    const tmpHtml = absIn + '.tmp.html';
    fs.writeFileSync(tmpHtml, html);
    // We'll clean up later
  }

  // Launch browser
  let browser;
  try {
    const opts = { headless: true };
    if (bInfo.status === 'fallback') opts.executablePath = bInfo.executablePath;
    browser = await chromium.launch(opts);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('shared libraries') || msg.includes('.so')) {
      console.error('\n✗ Missing system libraries. Run: npx playwright install-deps chromium\n');
    } else {
      console.error(`\n✗ Browser launch failed: ${msg}\n`);
    }
    process.exit(1);
  }

  try {
    const page = await browser.newPage();
    const loadFile = customCSS ? absIn + '.tmp.html' : absIn;
    await page.goto('file://' + loadFile, { waitUntil: 'networkidle' });

    // ── Pre-render hooks ──
    console.log('\n📋 Pre-render checks:');
    const preRenderResult = await preRenderHooks(page);
    const warnings = preRenderResult.warnings;
    const measuredContentHeight = preRenderResult.contentHeight;

    // ── Detect continuous-canvas mode (design_engine.py output) ──
    const continuousInfo = await page.evaluate(() => {
      const el = document.querySelector('.continuous-canvas');
      if (!el) return null;
      const root = getComputedStyle(document.documentElement);
      return {
        width: root.getPropertyValue('--canvas-w').trim() || '720px',
        height: root.getPropertyValue('--canvas-h').trim() || '960px',
        pages: el.querySelectorAll('.page-section').length,
      };
    });

    if (continuousInfo) {
      // Creative PDF: seamless multi-page canvas
      console.log(`\n🎨 Continuous canvas: ${continuousInfo.pages} pages @ ${continuousInfo.width} × ${continuousInfo.height}`);
      await page.pdf({
        path: absOut,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        width: continuousInfo.width,
        height: continuousInfo.height,
      });
    } else {
      // Standard document
      console.log('\n📄 Rendering PDF...');
      const pdfOpts = {
        path: absOut,
        printBackground: true,
        preferCSSPageSize: true,
        tagged: true,
      };

      if (width || height) {
        if (width) pdfOpts.width = width;
        if (height) pdfOpts.height = height;
        pdfOpts.margin = { top: 0, right: 0, bottom: 0, left: 0 };
        console.log(`   Custom size: ${pdfOpts.width || 'auto'} × ${pdfOpts.height || 'auto'}`);
      } else {
        // No explicit size: check if @page CSS defines a fixed size
        const pageSize = await page.evaluate(() => {
          const styles = Array.from(document.querySelectorAll('style'));
          for (const s of styles) {
            const text = s.textContent || '';
            const match = text.match(/@page\s*\{[^}]*size:\s*([\d.]+)px\s+([\d.]+)px/);
            if (match) return { width: parseFloat(match[1]), height: parseFloat(match[2]) };
          }
          return null;
        });

        if (pageSize) {
          // @page defines a fixed size — use preferCSSPageSize (already set above).
          // Playwright will paginate content at @page height boundaries seamlessly.
          // This is correct for both posters (seamless multi-page) and documents.
          pdfOpts.margin = { top: 0, right: 0, bottom: 0, left: 0 };
          console.log(`   @page size: ${pageSize.width}px × ${pageSize.height}px`);
          if (measuredContentHeight && measuredContentHeight > pageSize.height + 5) {
            const estPages = Math.ceil(measuredContentHeight / pageSize.height);
            console.log(`   Content height: ${measuredContentHeight}px → ~${estPages} pages`);
          }
        } else {
          pdfOpts.format = 'A4';
        }
      }

      await page.pdf(pdfOpts);
    }

    // Collect content stats from the page
    const stats = await collectStats(page);

    // ── pdf-lib post-processing ──
    console.log('\n🔧 Post-processing (pdf-lib):');
    const postResult = await postProcess(absOut, { mergeFiles, title });

    // Clean up temp HTML
    const tmpHtml = absIn + '.tmp.html';
    if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);

    // ── Report ──
    const sz = fs.statSync(absOut).size;
    console.log('\n' + '═'.repeat(40));
    console.log('  PDF Generated Successfully');
    console.log('═'.repeat(40));
    console.log(`  File:    ${path.basename(absOut)}`);
    console.log(`  Pages:   ${postResult.pageCount}`);
    console.log(`  Size:    ${prettyBytes(sz)}`);
    console.log(`  Words:   ~${stats.wordCount.toLocaleString()}`);
    console.log(`  Assets:  ${stats.figures} figures, ${stats.tables} tables`);
    console.log(`  Engine:  Playwright (no Paged.js)`);
    console.log(`  Path:    ${absOut}`);

    if (mergeFiles && mergeFiles.length && postResult.pageCount > postResult.originalPages) {
      console.log(`  Merged:  +${postResult.pageCount - postResult.originalPages} pages from ${mergeFiles.length} file(s)`);
    }

    if (warnings.length) {
      console.log('\n⚠ Warnings:');
      warnings.forEach(w => console.log(`  · ${w}`));
    }

    // Anomaly detection
    if (postResult.pageCount > 1 && stats.wordCount > 0) {
      const avgWordsPerPage = stats.wordCount / postResult.pageCount;
      if (avgWordsPerPage < 30) {
        console.log(`\n⚠ Low content density: ~${Math.round(avgWordsPerPage)} words/page (expected 100+)`);
      }
    }

  } catch (err) {
    console.error('\n✗ Conversion failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════════════

(async () => {
  try {
    const args = cli();
    await convert(args.inputFile, args.outputFile, args.customCSS, {
      width: args.width,
      height: args.height,
      mergeFiles: args.mergeFiles,
      title: args.title,
    });
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
