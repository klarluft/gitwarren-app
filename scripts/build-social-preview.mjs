/**
 * Render the repository's social preview image.
 *
 * GitHub shows this card wherever the repo is unfurled - Slack, X, LinkedIn,
 * iMessage - and it is the only picture most people see before deciding
 * whether to click. It is NOT part of the site's Open Graph setup: the site
 * derives its own card from the hero screenshot over in `gitwarren-site`. This
 * one is uploaded by hand in Settings -> General -> Social preview, because
 * GitHub exposes no API for it.
 *
 * Spec, from GitHub's docs: 1280x640 recommended, PNG/JPG/GIF, under 1 MB.
 *
 *   node scripts/build-social-preview.mjs
 *
 * Writes every variant to `screenshots-out/` (gitignored) and copies the
 * chosen one to `docs/social-preview.png`. Change CHOSEN to ship a different
 * direction.
 */
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  statSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'screenshots-out')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Which variant becomes `docs/social-preview.png`. */
const CHOSEN = 'mark'

const WIDTH = 1280
const HEIGHT = 640
/** Render at 2x and downsample, so the type is supersampled rather than aliased. */
const SCALE = 2

/* ---------------------------------------------------------------- assets */

const dataUri = (path, mime) =>
  `data:${mime};base64,${readFileSync(path).toString('base64')}`

const font = (name) =>
  dataUri(join(ROOT, 'scripts/social-preview/fonts', name), 'font/woff2')

const LOGO = dataUri(join(ROOT, 'src/renderer/src/assets/logo.png'), 'image/png')

/* ------------------------------------------------------------ the design */

/**
 * The palette is the site's, verbatim from `gitwarren-site/src/styles/global.css`.
 * The amber is not decorative: it is the colour the app badges uncommitted
 * work with. The magenta and teal are sampled from the logo, and used only for
 * the halo behind it.
 */
const CSS = `
@font-face { font-family: "Outfit"; src: url(${font('outfit-latin-600-normal.woff2')}) format("woff2"); font-weight: 600 }
@font-face { font-family: "Instrument Serif"; src: url(${font('instrument-serif-latin-400-normal.woff2')}) format("woff2"); font-weight: 400 }
@font-face { font-family: "IBM Plex Sans"; src: url(${font('ibm-plex-sans-latin-400-normal.woff2')}) format("woff2"); font-weight: 400 }
@font-face { font-family: "IBM Plex Sans"; src: url(${font('ibm-plex-sans-latin-500-normal.woff2')}) format("woff2"); font-weight: 500 }
@font-face { font-family: "IBM Plex Mono"; src: url(${font('ibm-plex-mono-latin-500-normal.woff2')}) format("woff2"); font-weight: 500 }

:root {
  --ground: #121110;
  --line: #232120;
  --line-strong: #35322e;
  --ink: #f2efe9;
  --muted: #a8a29a;
  --faint: #8f8a82;
  --accent: #f0b429;
  --magenta: #ff4d9d;
  --teal: #35d6c4;
}

* { margin: 0; padding: 0; box-sizing: border-box }
html { zoom: ${SCALE} }

body {
  width: ${WIDTH}px;
  height: ${HEIGHT}px;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans", sans-serif;
  position: relative;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* A dot grid, at the threshold of visible. It stops the dark ground reading
   as a flat black rectangle in a timeline without ever becoming texture. */
.grid {
  position: absolute; inset: 0;
  background-image: radial-gradient(circle, #3a3733 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: 0.42;
}

/* Warm the ground from the corner the mark sits in. */
.wash {
  position: absolute; inset: 0;
  background:
    radial-gradient(900px 620px at 84% 42%, rgba(240,180,41,0.10), transparent 62%),
    radial-gradient(760px 520px at 96% 14%, rgba(255,77,157,0.07), transparent 60%),
    radial-gradient(700px 520px at 74% 96%, rgba(53,214,196,0.06), transparent 60%);
}

/* A vignette, so the card keeps its edges against a white timeline. */
.vignette {
  position: absolute; inset: 0;
  box-shadow: inset 0 0 160px 40px rgba(0,0,0,0.55);
}

/* The amber rule down the left edge: the app's uncommitted badge colour, used
   here as the one piece of brand furniture that survives thumbnailing. */
.edge {
  position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
  background: linear-gradient(180deg, var(--accent), #c98d12);
}

.stage {
  position: relative; width: 100%; height: 100%;
  padding: 68px 72px 60px 80px;
  display: flex; flex-direction: column;
}

.eyebrow {
  font-family: "IBM Plex Mono", monospace; font-weight: 500;
  font-size: 17px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--accent);
}

.wordmark {
  font-family: "Outfit", sans-serif; font-weight: 600;
  letter-spacing: -0.022em; line-height: 1; color: var(--ink);
}

.tagline {
  font-family: "Instrument Serif", serif; font-weight: 400;
  color: #d9d4cb; letter-spacing: -0.005em;
}

.foot {
  margin-top: auto; padding-top: 26px; border-top: 1px solid var(--line);
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: "IBM Plex Mono", monospace; font-weight: 500;
  font-size: 18px; color: var(--faint); letter-spacing: 0.01em;
}
.foot .site { color: var(--muted) }

/* The mark, with a glow built from the logo's own colours. */
.mark { position: relative; flex: none }
.mark img {
  display: block; width: 100%; height: 100%; border-radius: 50%;
  filter: drop-shadow(0 22px 48px rgba(0,0,0,0.7));
}
.mark::before {
  content: ""; position: absolute; inset: -18%; border-radius: 50%;
  background: conic-gradient(from 200deg, var(--magenta), var(--accent), var(--teal), var(--magenta));
  filter: blur(46px); opacity: 0.42; z-index: -1;
}
.mark::after {
  content: ""; position: absolute; inset: -3px;
  border-radius: 50%; border: 1px solid rgba(242,239,233,0.14);
}

/* ------------------------------------------------- A: mark (recommended) */
.mark-layout { flex-direction: row; align-items: center; gap: 64px }
.mark-layout .copy { display: flex; flex-direction: column; height: 100%; flex: 1; min-width: 0 }
/* Auto margins on both sides split the leftover height evenly above and below
   the type, instead of pooling it all between the tagline and the rule. */
.mark-layout .block { margin: auto 0 }
.mark-layout .foot { margin-top: 0 }
.mark-layout .wordmark { font-size: 96px; margin-top: 20px }
.mark-layout .tagline { font-size: 40px; line-height: 1.24; margin-top: 24px; max-width: 15.5em }
.mark-layout .mark { width: 292px; height: 292px }

/* ------------------------------------------------------------ C: centred */
.centred { align-items: center; justify-content: center; text-align: center; padding: 56px 72px 52px }
.centred .mark { width: 190px; height: 190px }
.centred .wordmark { font-size: 82px; margin-top: 30px }
.centred .tagline { font-size: 31px; line-height: 1.3; margin-top: 18px; max-width: 20em }
.centred .eyebrow { margin-top: 26px; font-size: 15px }

`

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`

const FURNITURE =
  '<div class="grid"></div><div class="wash"></div><div class="vignette"></div><div class="edge"></div>'

const FOOT =
  '<div class="foot"><span>macOS &middot; Windows &middot; Linux</span><span class="site">gitwarren.com</span></div>'

const TAGLINE = 'Review your agent&rsquo;s diff<br>before it becomes a commit.'

const VARIANTS = {
  /** The mark carries the brand, the type carries the pitch. Survives a 480px unfurl. */
  mark: page(`${FURNITURE}
    <div class="stage mark-layout">
      <div class="copy">
        <div class="block">
          <div class="eyebrow">Local-only code review</div>
          <div class="wordmark">GitWarren</div>
          <div class="tagline">${TAGLINE}</div>
        </div>
        ${FOOT}
      </div>
      <div class="mark"><img src="${LOGO}" alt=""></div>
    </div>`),

  /** Everything on the centre line. The most legible when the card is scaled far down. */
  centred: page(`${FURNITURE}
    <div class="stage centred">
      <div class="mark"><img src="${LOGO}" alt=""></div>
      <div class="wordmark">GitWarren</div>
      <div class="tagline">Review your agent&rsquo;s diff before it becomes a commit.</div>
      <div class="eyebrow">Local-only &middot; no server &middot; no account</div>
    </div>`)
}

/*
 * A third direction - the review screenshot bled off the right edge - was
 * tried and dropped. Two reasons, both fatal: at the size these cards are
 * actually unfurled the diff is unreadable texture rather than product, and
 * the app's branch header prints an absolute worktree path, which put a home
 * directory on a public image.
 */

/* ----------------------------------------------------------------- render */

mkdirSync(OUT_DIR, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'gw-og-'))

for (const [name, html] of Object.entries(VARIANTS)) {
  const source = join(scratch, `${name}.html`)
  const big = join(OUT_DIR, `social-preview-${name}@2x.png`)
  const final = join(OUT_DIR, `social-preview-${name}.png`)
  writeFileSync(source, html)

  // Headless Chrome writes the PNG and then, often, declines to exit. Cap the
  // wait and judge the run by whether the file appeared, not by how it died.
  // The private --user-data-dir keeps this away from any Chrome already open.
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${WIDTH * SCALE},${HEIGHT * SCALE}`,
        `--screenshot=${big}`,
        '--virtual-time-budget=6000',
        `--user-data-dir=${join(scratch, `profile-${name}`)}`,
        `file://${source}`
      ],
      { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' }
    )
  } catch {
    // Fall through to the existence check below.
  }

  if (!existsSync(big)) throw new Error(`Chrome produced no screenshot for "${name}"`)

  // Supersample down to the size GitHub actually asks for.
  execFileSync('sips', ['-z', String(HEIGHT), String(WIDTH), big, '--out', final], {
    stdio: 'ignore'
  })

  const kb = Math.round(statSync(final).size / 1024)
  const over = kb > 1024 ? '  !! over GitHub 1 MB limit' : ''
  console.log(`${final}  ${WIDTH}x${HEIGHT}  ${kb} KB${over}`)
}

const shipped = join(ROOT, 'docs/social-preview.png')
copyFileSync(join(OUT_DIR, `social-preview-${CHOSEN}.png`), shipped)
console.log(`\nchosen: ${CHOSEN}  ->  docs/social-preview.png`)
