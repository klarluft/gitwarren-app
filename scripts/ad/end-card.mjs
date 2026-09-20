/**
 * The ad's end card, in both aspect ratios.
 *
 * The palette and type are the social preview's (`build-social-preview.mjs`),
 * so the last frame of the ad and the card GitHub unfurls are recognisably one
 * thing. Rendered at 2x by a headless Chrome and downsampled, so the type is
 * supersampled rather than aliased.
 *
 *   node scripts/ad/end-card.mjs
 *
 * Writes `end-card-16x9.png` (1920x1080) and `end-card-9x16.png` (1080x1920)
 * into VIDEO_DIR (default: the gitignored `video-out/ad/`).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = process.env.VIDEO_DIR ?? join(ROOT, 'video-out', 'ad')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SCALE = 2

const dataUri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`
const font = (name) => dataUri(join(ROOT, 'scripts/social-preview/fonts', name), 'font/woff2')
const LOGO = dataUri(join(ROOT, 'src/renderer/src/assets/logo.png'), 'image/png')

function page({ width, height, portrait }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Outfit"; src: url(${font('outfit-latin-600-normal.woff2')}) format("woff2"); font-weight: 600 }
@font-face { font-family: "IBM Plex Sans"; src: url(${font('ibm-plex-sans-latin-400-normal.woff2')}) format("woff2"); font-weight: 400 }
@font-face { font-family: "IBM Plex Sans"; src: url(${font('ibm-plex-sans-latin-500-normal.woff2')}) format("woff2"); font-weight: 500 }
@font-face { font-family: "IBM Plex Mono"; src: url(${font('ibm-plex-mono-latin-500-normal.woff2')}) format("woff2"); font-weight: 500 }
:root { --ground:#121110; --ink:#f2efe9; --muted:#a8a29a; --faint:#8f8a82; --accent:#f0b429; --magenta:#ff4d9d; --teal:#35d6c4; --line:#35322e }
* { margin:0; padding:0; box-sizing:border-box }
html { zoom: ${SCALE} }
body { width:${width}px; height:${height}px; background:var(--ground); color:var(--ink); font-family:"IBM Plex Sans",sans-serif;
  position:relative; overflow:hidden; -webkit-font-smoothing:antialiased }
.grid { position:absolute; inset:0; background-image:radial-gradient(circle,#3a3733 1px,transparent 1px); background-size:32px 32px; opacity:.42 }
.wash { position:absolute; inset:0; background:
  radial-gradient(${portrait ? '700px 700px at 50% 34%' : '900px 620px at 50% 40%'}, rgba(240,180,41,.10), transparent 62%),
  radial-gradient(${portrait ? '500px 500px at 20% 10%' : '760px 520px at 8% 12%'}, rgba(255,77,157,.07), transparent 60%),
  radial-gradient(${portrait ? '500px 500px at 80% 92%' : '760px 520px at 92% 88%'}, rgba(53,214,196,.07), transparent 60%) }
.card { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;
  padding:${portrait ? '0 72px' : '0 120px'} }
.logo { width:${portrait ? 160 : 132}px; height:${portrait ? 160 : 132}px; margin-bottom:${portrait ? 40 : 28}px;
  filter: drop-shadow(0 18px 40px rgba(0,0,0,.55)) }
.name { font-family:"Outfit",sans-serif; font-weight:600; font-size:${portrait ? 92 : 84}px; letter-spacing:-.02em; line-height:1 }
.url { font-family:"IBM Plex Mono",monospace; font-weight:500; font-size:${portrait ? 34 : 30}px; letter-spacing:.06em; color:var(--accent);
  margin-top:${portrait ? 26 : 18}px }
.line { margin-top:${portrait ? 64 : 44}px; font-size:${portrait ? 30 : 26}px; color:var(--muted); line-height:1.5; max-width:${portrait ? 820 : 1100}px }
.line b { color:var(--ink); font-weight:500 }
.dot { color:var(--faint); padding:0 .45em }
</style></head><body>
<div class="grid"></div><div class="wash"></div>
<div class="card">
  <img class="logo" src="${LOGO}" alt="">
  <div class="name">GitWarren</div>
  <div class="url">gitwarren.com</div>
  <div class="line">
    <b>Free and open source</b><span class="dot">·</span>GPL-3${portrait ? '<br>' : '<span class="dot">·</span>'}
    macOS<span class="dot">·</span>Windows<span class="dot">·</span>Linux<br>
    Desktop app<span class="dot">·</span>command line<span class="dot">·</span>browser tab<br>
    Works with any coding agent
  </div>
</div>
</body></html>`
}

/**
 * Render a page to a PNG of exactly `width` x `height`, through a headless
 * Chrome at `scale` and a downsample. Shared with `rough.mjs`, whose slates
 * are made the same way because Homebrew's ffmpeg is built without `drawtext`.
 */
export function renderHtml(html, { width, height, scale = SCALE }, out) {
  const work = mkdtempSync(join(tmpdir(), 'gw-render-'))
  const source = join(work, 'page.html')
  const big = join(work, 'page@big.png')
  writeFileSync(source, html)
  // Headless Chrome writes the PNG and then, often, declines to exit. Cap the
  // wait and judge the run by whether the file appeared, not by how it died.
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${width * scale},${height * scale}`,
        `--screenshot=${big}`,
        '--virtual-time-budget=6000',
        `--user-data-dir=${join(work, 'profile')}`,
        `file://${source}`
      ],
      { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' }
    )
  } catch {
    // Fall through to the existence check below.
  }
  if (!existsSync(big)) throw new Error(`Chrome produced no screenshot for ${out}`)
  mkdirSync(dirname(out), { recursive: true })
  if (scale === 1) copyFileSync(big, out)
  else execFileSync('sips', ['-z', String(height), String(width), big, '--out', out], { stdio: 'ignore' })
  return out
}

function render(name, size) {
  console.log(renderHtml(page(size), size, join(OUT_DIR, `${name}.png`)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  render('end-card-16x9', { width: 1920, height: 1080, portrait: false })
  render('end-card-9x16', { width: 1080, height: 1920, portrait: true })
}
