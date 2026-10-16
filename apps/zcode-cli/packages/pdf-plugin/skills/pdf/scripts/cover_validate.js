#!/usr/bin/env node
/**
 * cover_validate.js — Cover page overlap detection via Playwright rendering
 *
 * Detects text-vs-decorative-line overlap on cover HTML pages by:
 *   1. Rendering the HTML in Playwright
 *   2. Waiting for fonts to load
 *   3. Measuring bounding boxes of text elements and decorative line elements
 *   4. Checking for Y-axis overlap (minimum spacing = 1U = 5% of page width ≈ 30pt)
 *
 * Usage:
 *   node cover_validate.js cover.html
 *   node cover_validate.js cover.html --width 210mm --height 297mm
 *   node cover_validate.js cover.html --min-gap 30   # custom min gap in px (default: auto = 5% of width)
 *
 * Exit codes:
 *   0 = no overlap issues found
 *   1 = overlap detected (prints details to stderr)
 *   2 = script error (missing file, browser launch failure, etc.)
 *
 * This script is ONLY for cover pages. Do NOT use it on:
 *   - Multi-page documents (use html2pdf-next.js pre-render checks)
 *   - Posters (use html2poster.js which handles overflow automatically)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Playwright import ──

let playwright;
try {
  playwright = require('playwright');
} catch {
  try {
    playwright = require('playwright-core');
  } catch {
    console.error('✗ Neither playwright nor playwright-core is installed.');
    process.exit(2);
  }
}

// ── Chromium resolution (shared logic with html2poster.js) ──

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
  let input = null, width = '210mm', height = '297mm', minGap = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--width') width = tokens[++i];
    else if (t === '--height') height = tokens[++i];
    else if (t === '--min-gap') minGap = parseFloat(tokens[++i]);
    else if (t === '--help' || t === '-h') {
      console.log(`Usage: node cover_validate.js <cover.html> [options]

Options:
  --width <val>     Page width (default: 210mm)
  --height <val>    Page height (default: 297mm)
  --min-gap <px>    Minimum gap between text and decorative lines (default: 5% of width)
  --help            Show this help`);
      process.exit(0);
    } else if (!t.startsWith('-') && !input) {
      input = t;
    }
  }
  return { input, width, height, minGap };
}

// ── Convert CSS dimension string to px for viewport ──

function dimToPx(dim) {
  if (!dim) return null;
  const s = String(dim).trim();
  const num = parseFloat(s);
  if (s.endsWith('mm')) return Math.round(num * 3.7795);  // 1mm ≈ 3.7795px at 96dpi
  if (s.endsWith('cm')) return Math.round(num * 37.795);
  if (s.endsWith('in')) return Math.round(num * 96);
  if (s.endsWith('px') || !isNaN(num)) return Math.round(num);
  return null;
}

// ── Decorative line detection heuristics ──
// A decorative line is an element that:
//   - Is very thin in one dimension (height ≤ 5px or width ≤ 5px)
//   - OR is an <hr> element
//   - OR has a large aspect ratio (> 10:1 or < 1:10)
//   - AND is not inside a text element

const DECORATIVE_LINE_DETECTION = `
(function detectOverlaps(minGapPx) {
  // Collect all elements
  const allElements = document.querySelectorAll('*');

  const textElements = [];
  const lineElements = [];

  // Classify elements
  for (const el of allElements) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const tag = el.tagName.toLowerCase();
    const style = getComputedStyle(el);

    // Skip invisible elements
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    // Detect decorative lines
    const isHR = tag === 'hr';
    const isThinH = rect.height <= 5 && rect.width > 20;  // thin horizontal line
    const isThinV = rect.width <= 5 && rect.height > 20;   // thin vertical line
    const aspectH = rect.width / rect.height;
    const aspectV = rect.height / rect.width;
    const isWideRatio = aspectH > 15 && rect.height <= 8;  // very wide, very thin
    const isTallRatio = aspectV > 15 && rect.width <= 8;   // very tall, very thin

    // Check if element has only border (no text content, no background image)
    const hasOnlyBorder = (
      el.textContent.trim() === '' &&
      style.backgroundImage === 'none' &&
      (style.borderTopWidth !== '0px' || style.borderBottomWidth !== '0px' ||
       style.borderLeftWidth !== '0px' || style.borderRightWidth !== '0px')
    );
    const isBorderLine = hasOnlyBorder && (rect.height <= 8 || rect.width <= 8);

    if (isHR || isThinH || isThinV || isWideRatio || isTallRatio || isBorderLine) {
      lineElements.push({
        tag: tag,
        class: el.className || '',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        type: isThinH || isWideRatio ? 'horizontal' : (isThinV || isTallRatio ? 'vertical' : (rect.width >= rect.height ? 'horizontal' : 'vertical')),
      });
      continue;
    }

    // Detect text elements (has direct text content or is a heading/paragraph)
    const textTags = ['h1','h2','h3','h4','h5','h6','p','span','a','li','td','th','label','summary'];
    const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());

    if (textTags.includes(tag) || hasDirectText) {
      // Skip if this is inside a decorative element
      if (rect.height < 3) continue;

      textElements.push({
        tag: tag,
        class: el.className || '',
        text: el.textContent.trim().substring(0, 60),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
  }

  // De-duplicate: if a parent and child text element both overlap the same line,
  // only keep the more specific (smaller) one to avoid duplicate reports.
  // Sort text elements by area (smallest first) so we can skip parents.
  textElements.sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

  // Check overlaps between text elements and line elements
  const overlaps = [];
  const reportedPairs = new Set(); // track "lineIndex:textContent" to deduplicate

  for (const text of textElements) {
    for (const line of lineElements) {
      const tr = text.rect;
      const lr = line.rect;

      if (line.type === 'horizontal') {
        // Check vertical overlap/proximity
        const textTop = tr.y;
        const textBottom = tr.y + tr.height;
        const lineTop = lr.y;
        const lineBottom = lr.y + lr.height;

        // Check horizontal overlap (they must share some X range)
        const xOverlap = !(tr.x + tr.width < lr.x || lr.x + lr.width < tr.x);
        if (!xOverlap) continue;

        // Calculate vertical gap
        let vGap;
        if (lineTop >= textBottom) {
          vGap = lineTop - textBottom;  // line is below text
        } else if (textTop >= lineBottom) {
          vGap = textTop - lineBottom;  // line is above text
        } else {
          vGap = 0;  // overlapping
        }

        if (vGap < minGapPx) {
          // De-dup: same line region, only report the smallest (most specific) text element
          const lineKey = 'h:' + Math.round(lr.x) + ',' + Math.round(lr.y);
          if (!reportedPairs.has(lineKey)) {
            reportedPairs.add(lineKey);
            overlaps.push({
              text: text.text,
              textTag: text.tag,
              textClass: text.class,
              textRect: tr,
              lineTag: line.tag,
              lineClass: line.class,
              lineRect: lr,
              lineType: line.type,
              gap: Math.round(vGap * 10) / 10,
              required: minGapPx,
            });
          }
        }
      } else if (line.type === 'vertical') {
        // Check horizontal overlap/proximity
        const textLeft = tr.x;
        const textRight = tr.x + tr.width;
        const lineLeft = lr.x;
        const lineRight = lr.x + lr.width;

        // Check vertical overlap (they must share some Y range)
        const yOverlap = !(tr.y + tr.height < lr.y || lr.y + lr.height < tr.y);
        if (!yOverlap) continue;

        // Calculate horizontal gap
        let hGap;
        if (lineLeft >= textRight) {
          hGap = lineLeft - textRight;
        } else if (textLeft >= lineRight) {
          hGap = textLeft - lineRight;
        } else {
          hGap = 0;
        }

        if (hGap < minGapPx) {
          const lineKey = 'v:' + Math.round(lr.x) + ',' + Math.round(lr.y);
          if (!reportedPairs.has(lineKey)) {
            reportedPairs.add(lineKey);
            overlaps.push({
              text: text.text,
              textTag: text.tag,
              textClass: text.class,
              textRect: tr,
              lineTag: line.tag,
              lineClass: line.class,
              lineRect: lr,
              lineType: line.type,
              gap: Math.round(hGap * 10) / 10,
              required: minGapPx,
            });
          }
        }
      }
    }
  }

  return {
    textElements: textElements.length,
    lineElements: lineElements.length,
    overlaps: overlaps,
  };
})
`;

// ── Main ──

async function main() {
  const { input, width, height, minGap } = parseArgs(process.argv);

  if (!input) {
    console.error('✗ No input file specified. Usage: node cover_validate.js cover.html');
    process.exit(2);
  }

  const absIn = path.resolve(input);
  if (!fs.existsSync(absIn)) {
    console.error(`✗ File not found: ${absIn}`);
    process.exit(2);
  }

  const widthPx = dimToPx(width) || 794;   // A4 width in px
  const heightPx = dimToPx(height) || 1123; // A4 height in px
  const gap = minGap || Math.round(widthPx * 0.05);  // 1U = 5% of page width

  console.log(`🔍 cover_validate — Cover overlap detection`);
  console.log(`   Input:  ${absIn}`);
  console.log(`   Page:   ${widthPx}×${heightPx}px`);
  console.log(`   Min gap: ${gap}px (1U)`);

  const { chromium } = playwright;
  const bInfo = resolveChromium(chromium);

  if (bInfo.status === 'missing') {
    console.error('✗ No Chromium found. Install via: npx playwright install chromium');
    process.exit(2);
  }

  let browser;
  try {
    const opts = { headless: true };
    if (bInfo.status === 'fallback') opts.executablePath = bInfo.executablePath;
    browser = await chromium.launch(opts);
  } catch (err) {
    console.error(`✗ Browser launch failed: ${err.message}`);
    process.exit(2);
  }

  try {
    const page = await browser.newPage({ viewport: { width: widthPx, height: heightPx } });
    await page.goto('file://' + absIn, { waitUntil: 'networkidle' });
    console.log(`   ✓ HTML loaded`);

    // Wait for fonts
    const fontsLoaded = await page.evaluate(() =>
      document.fonts.ready.then(() => document.fonts.size)
    ).catch(() => 0);
    console.log(`   ✓ Fonts: ${fontsLoaded} loaded`);

    // Run overlap detection
    const result = await page.evaluate(`(${DECORATIVE_LINE_DETECTION})(${gap})`);

    console.log(`   ✓ Found ${result.textElements} text elements, ${result.lineElements} decorative lines`);

    if (result.overlaps.length === 0) {
      console.log(`\n   ✅ No overlap issues found`);
      process.exit(0);
    }

    // Report overlaps
    console.error(`\n   ❌ Found ${result.overlaps.length} text-line overlap(s):\n`);

    for (const o of result.overlaps) {
      const direction = o.lineType === 'vertical' ? 'horizontal' : 'vertical';
      console.error(`   ERROR: ${direction} gap = ${o.gap}px (required ≥ ${o.required}px)`);
      console.error(`     Text: <${o.textTag}> "${o.text}" @ y=${Math.round(o.textRect.y)}-${Math.round(o.textRect.y + o.textRect.height)}`);
      console.error(`     Line: <${o.lineTag}${o.lineClass ? '.' + o.lineClass.split(' ')[0] : ''}> [${o.lineType}] @ y=${Math.round(o.lineRect.y)}-${Math.round(o.lineRect.y + o.lineRect.height)}`);
      console.error(`     Fix: Move the decorative line at least ${Math.ceil(o.required - o.gap)}px away from the text.`);
      console.error('');
    }

    process.exit(1);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`✗ Unexpected error: ${err.message}`);
  process.exit(2);
});
