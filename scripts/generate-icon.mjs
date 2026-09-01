/**
 * Generates build/icon.png, the source electron-builder converts into .icns
 * (macOS), .ico (Windows) and the AppImage icon.
 *
 * Written by hand rather than pulled from a design tool so the icon is
 * reproducible from source and the repo carries no binary blob it cannot
 * regenerate. Shapes are drawn as signed distance fields, which gives clean
 * antialiasing without a canvas library.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { crc32 } from 'node:zlib'

const SIZE = 1024

// --- signed distance helpers (negative = inside) ---------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function sdRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius)
  const qy = Math.abs(py - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r
}

/** Distance to a thick line segment (a capsule). */
function sdSegment(px, py, ax, ay, bx, by, thickness) {
  const dx = bx - ax
  const dy = by - ay
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(px - ax - dx * t, py - ay - dy * t) - thickness
}

/** Coverage of a shape at a pixel, antialiased over roughly one pixel. */
const coverage = (distance) => clamp(0.5 - distance, 0, 1)

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// --- the mark ---------------------------------------------------------------
// A commit graph: a trunk with one branch splitting off and merging back, which
// is the shape of the thing being reviewed.

const INK_TOP = [37, 42, 63]
const INK_BOTTOM = [22, 25, 40]
const ACCENT = [125, 165, 255]
const ACCENT_DIM = [96, 132, 214]

const pixels = Buffer.alloc(SIZE * SIZE * 4)

const M = SIZE / 1024 // scale factor, so the geometry below reads in 1024 units
const trunkX = 380 * M
const branchX = 644 * M
const nodeR = 52 * M
const lineW = 30 * M
const yTop = 232 * M
const yMid = 512 * M
const yBottom = 792 * M

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const px = x + 0.5
    const py = y + 0.5

    // Background plate.
    const plate = coverage(sdRoundedRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 224 * M))
    let colour = mix(INK_TOP, INK_BOTTOM, py / SIZE)

    // Trunk line, then the branch curve, approximated by short segments.
    let ink = coverage(sdSegment(px, py, trunkX, yTop, trunkX, yBottom, lineW / 2))

    const steps = 24
    for (let i = 0; i < steps; i += 1) {
      const t0 = i / steps
      const t1 = (i + 1) / steps
      // Ease the horizontal move so the branch leaves and rejoins smoothly.
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t))
      const bx0 = trunkX + (branchX - trunkX) * ease(clamp(t0 * 2, 0, 1))
      const bx1 = trunkX + (branchX - trunkX) * ease(clamp(t1 * 2, 0, 1))
      const by0 = yTop + (yMid - yTop) * t0
      const by1 = yTop + (yMid - yTop) * t1
      ink = Math.max(ink, coverage(sdSegment(px, py, bx0, by0, bx1, by1, lineW / 2)))
      // Mirror it back into the trunk lower down.
      ink = Math.max(
        ink,
        coverage(sdSegment(px, py, bx0, yBottom - (by0 - yTop), bx1, yBottom - (by1 - yTop), lineW / 2))
      )
    }

    const inkColour = mix(ACCENT_DIM, ACCENT, clamp((px - 300 * M) / (500 * M), 0, 1))
    colour = mix(colour, inkColour, ink * plate)

    // Commit nodes sit on top of the lines.
    const nodes = Math.max(
      coverage(sdCircle(px, py, trunkX, yTop, nodeR)),
      coverage(sdCircle(px, py, trunkX, yBottom, nodeR)),
      coverage(sdCircle(px, py, branchX, yMid, nodeR))
    )
    colour = mix(colour, ACCENT, nodes * plate)

    const offset = (y * SIZE + x) * 4
    pixels[offset] = Math.round(colour[0])
    pixels[offset + 1] = Math.round(colour[1])
    pixels[offset + 2] = Math.round(colour[2])
    pixels[offset + 3] = Math.round(plate * 255)
  }
}

// --- PNG encoding -----------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
// 10-12: compression, filter, interlace - all zero

// Each scanline is prefixed with its filter type (0 = none).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`build/icon.png written (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`)
