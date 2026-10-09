#!/usr/bin/env node
// Renders the README images in the Black Forest Hackathon's look (colours and
// fonts of hackathon.badencampus.de). Needs Google Chrome and ImageMagick.
//
//   node assets/src/render.mjs
//
// Writes assets/*.png at twice the CSS size, so they stay sharp on retina.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');
const svg = (name) => readFileSync(join(HERE, `${name}.svg`), 'utf8').trim();

const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!chrome) throw new Error('Google Chrome not found; set CHROME_PATH');

const CSS = `
  html,body{margin:0;background:#0a1116;color:#fff;font-family:"JetBrains Mono",monospace;-webkit-font-smoothing:antialiased}
  .page{position:relative;box-sizing:border-box;overflow:hidden;background:#0a1116}
  .grid{position:absolute;inset:0;background:
      linear-gradient(90deg,rgba(55,65,81,.22) 1px,transparent 1px) 0 0/48px 48px,
      linear-gradient(rgba(55,65,81,.22) 1px,transparent 1px) 0 0/48px 48px;
    -webkit-mask-image:radial-gradient(900px 520px at 85% 30%,#000 10%,transparent 75%)}
  .h{font-family:Oswald,sans-serif;text-transform:uppercase;letter-spacing:.01em;line-height:.95;margin:0}
  .y{color:#fff200}
  .tag{display:inline-block;background:#fff200;color:#0f181f;font-weight:700;font-size:15px;letter-spacing:.12em;text-transform:uppercase;padding:7px 14px}
  .tag.o{background:transparent;color:#fff200;box-shadow:inset 0 0 0 2px #fff200}
  .muted{color:rgba(255,255,255,.6)}
  .card{background:#0f181f;border:1px solid #374151}
  .wm{font-family:Oswald,sans-serif;font-weight:600;font-size:26px;letter-spacing:.02em}
  .logos{display:flex;align-items:center;gap:44px}
  .logos .koch svg{height:30px;width:auto;display:block}
  .logo{display:flex;align-items:center;gap:12px;font-family:Oswald,sans-serif;font-weight:500;font-size:27px;letter-spacing:.02em}
  .logo svg{width:36px;height:36px;display:block}
  .logo .hc{width:36px;height:36px;border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px #374151}
`;

const head = (w, h) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS} .page{width:${w}px;height:${h}px}</style></head><body>`;

const wordmark = `<div class="wm">BLACK<span class="y">FOREST</span>HACKATHON</div>`;
const logos = `<div class="logos">
  <div class="koch">${svg('koch')}</div>
  <div class="logo"><span class="hc">${svg('helpcode')}</span>helpcode.ai</div>
  <div class="logo">${svg('anythingmcp')}AnythingMCP</div>
</div>`;

const pages = {
  banner: [1280, 640, `
  <div class="page" style="padding:56px 72px">
    <div class="grid"></div>
    <div style="position:relative;display:flex;justify-content:space-between;align-items:center">
      ${wordmark}<div class="muted" style="font-size:18px;letter-spacing:.06em">16.–18.10.2026 · OFFENBURG</div>
    </div>
    <div style="position:relative;margin-top:58px;display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <span class="tag">Challenge · Smart Automation</span>
        <h1 class="h" style="font-size:124px;font-weight:700;margin-top:30px">CODE<span class="y">BOUND.</span></h1>
        <div style="font-size:23px;margin-top:22px;max-width:640px;line-height:1.45" class="muted">Safe Script Sandbox for AI Agents<br>in AnythingMCP</div>
      </div>
      <div class="card" style="width:400px;margin-top:8px;padding:22px 24px;font-size:15px;line-height:2;white-space:nowrap">
        <div class="muted">$ npm run check</div>
        <div><span class="y">✔</span> P1  processor chain</div>
        <div><span class="y">✔</span> F2  price_drift_check <span class="muted">450→4</span></div>
        <div><span class="y">✔</span> F4  stuck_orders</div>
        <div><span class="y">✔</span> S1  no credential in output</div>
        <div class="muted">Must 6/6 · scans 3/3</div>
      </div>
    </div>
    <div style="position:absolute;left:72px;right:72px;bottom:46px;border-top:1px solid #374151;padding-top:26px;display:flex;justify-content:space-between;align-items:center">
      <div class="muted" style="font-size:15px;letter-spacing:.14em">CHALLENGE BY</div>
      ${logos}
    </div>
  </div>`],

  problem: [1280, 430, `
  <div class="page" style="padding:52px 72px">
    <span class="tag">The problem</span>
    <h2 class="h" style="font-size:58px;font-weight:600;margin-top:22px">Every result travels <span class="y">through the model.</span></h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:40px">
      ${[
        ['1 in 8', 'tool calls in production return more than 50 KB'],
        ['44 MB', 'the largest single answer a tool returned'],
        ['450 → 4', 'price_drift_check: articles in, rows the agent needs out'],
      ].map(([n, t]) => `<div class="card" style="padding:26px 28px">
          <div class="h y" style="font-size:64px;font-weight:700">${n}</div>
          <div class="muted" style="font-size:17px;line-height:1.5;margin-top:14px">${t}</div>
        </div>`).join('')}
    </div>
  </div>`],

  levels: [1280, 600, `
  <div class="page" style="padding:52px 72px">
    <span class="tag">The challenge</span>
    <h2 class="h" style="font-size:58px;font-weight:600;margin-top:22px">One sandbox. <span class="y">Three levels of trust.</span></h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:40px">
      ${[
        ['Level 1 · Must', '', 'Processor chains', "Reshape a tool's answer before the model sees it: convert, add, clean, fail loudly.", 'P1 · P2'],
        ['Level 2 · Must', '', 'Scripts', "Call the workspace's tools and return four rows instead of four hundred.", 'F1 · F2 · F3 · F4'],
        ['Level 3 · Should', 'o', 'Scripts with secrets', "Direct calls with injected credentials, only to the workspace's own connectors. The key never shows.", 'F5'],
      ].map(([tag, cls, title, text, checks]) => `<div class="card" style="padding:26px 28px;display:flex;flex-direction:column;height:290px;box-sizing:border-box">
          <div><span class="tag ${cls}" style="font-size:13px">${tag}</span></div>
          <div class="h" style="font-size:36px;font-weight:600;margin-top:20px">${title}</div>
          <div class="muted" style="font-size:16px;line-height:1.55;margin-top:14px;flex:1">${text}</div>
          <div class="y" style="font-size:15px;letter-spacing:.08em">${checks}</div>
        </div>`).join('')}
    </div>
    <div class="muted" style="font-size:16px;margin-top:26px;letter-spacing:.04em">On every level: secret scans <span class="y">S1–S3</span> and attack cards <span class="y">A1–A13</span>. One workspace, nothing else.</div>
  </div>`],

  partners: [1280, 170, `
  <div class="page" style="padding:0 72px;display:flex;align-items:center;justify-content:space-between">
    ${wordmark}
    ${logos}
  </div>`],
};

const work = mkdtempSync(join(tmpdir(), 'codebound-assets-'));
for (const [name, [w, h, body]] of Object.entries(pages)) {
  const html = join(work, `${name}.html`);
  const shot = join(work, `${name}.png`);
  writeFileSync(html, `${head(w, h)}${body}</body></html>`);
  execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${w},${h}`, `--screenshot=${shot}`, '--virtual-time-budget=8000', `file://${html}`], { stdio: 'ignore' });
  execFileSync('magick', [shot, '-strip', '-define', 'png:compression-level=9', join(OUT, `${name}.png`)]);
  console.log(`assets/${name}.png`);
}
