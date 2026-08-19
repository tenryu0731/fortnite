/**
 * harness.cjs — shared plumbing for every headless verification script.
 *
 * IMPORTANT (measurement environment): this container has no GPU, so headless
 * Chromium falls back to SwiftShader (software rasteriser). Wall-clock fps here
 * is therefore NOT representative of a phone. Primary gates are CPU frame time
 * and draw-command budgets; SwiftShader wall clock is recorded as a secondary
 * signal only. See ARCHITECTURE.md §11.3.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const BASELINE = path.join(__dirname, 'baseline');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Mobile device profiles used across the suite (CSS px + DPR). */
const DEVICES = {
  // Reference target: mid-range Android phone, portrait.
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // Landscape is the actual play orientation for this game.
  phoneLandscape: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  // Lower-end: smaller logical viewport, DPR 2.
  phoneSmall: { width: 667, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function launch() {
  return chromium.launch({
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-device-scale-factor=1',
      '--disable-lcd-text',
      '--font-render-hinting=none',
    ],
  });
}

/**
 * Open the game in a page and wait until `__GAME.ready` resolves.
 * `query` is merged into the URL (seed/quality/scenario...).
 */
async function openGame(browser, { device = 'phoneLandscape', port, query = {}, timeout = 120000 } = {}) {
  const profile = DEVICES[device] || DEVICES.phoneLandscape;
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

  const qs = new URLSearchParams({ seed: '1337', ...query }).toString();
  await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction(() => window.__GAME && window.__GAME.ready, null, { timeout: 30000 });
    await page.evaluate(() => window.__GAME.ready);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout });
  } catch (err) {
    throw new Error(`game failed to become ready: ${err.message}\n--- console ---\n${logs.join('\n')}`);
  }

  return { context, page, logs, profile };
}

function ensureDirs() {
  for (const d of [OUT, BASELINE]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/** Console-friendly pass/fail line. */
function check(label, ok, detail = '') {
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? '  ' + detail : ''}`);
  return ok;
}

function fmt(n, d = 2) { return typeof n === 'number' ? n.toFixed(d) : String(n); }

module.exports = { startServer, launch, openGame, DEVICES, ROOT, OUT, BASELINE, ensureDirs, check, fmt };
