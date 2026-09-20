# The GitWarren ad — script and storyboard

A 55-second horizontal piece for gitwarren.com, the README, YouTube and the
launch post, and a 25-second vertical cut of the same material for X, Shorts
and Reels. One rule for everything below: **a video model generates the
people; the scripted capture pipeline generates every pixel of the product.**
The zoom from a person's screen into the app is a compositing step, never a
prompt.

The argument of the piece: an agent finished and wants a review; that finds
you anywhere; GitWarren brings the review to wherever you are, on your own
machines, and the phone over the tailnet is the beat that proves it.

Beats end at a fixed second from the first frame, as in `capture-dhh-clip.mjs`:
overhead comes out of the hold, never the total.

## Status (2026-09-20)

Captured, at `~/Desktop/gitwarren-ad/` and in `video-out/ad/`: the seven
product clips (`review-opens` 5.1s, `scroll-diff` 5.1s, `comment-and-reply`
8.2s, `browse-untouched` 12.9s, `hosts` 6.1s, `conversation` 5.1s, `home`
4.1s), both end cards, and `rough.mp4` - the clips on this clock with a slate
wherever a Runway beat, the terminal or the phone goes.

The rough runs 1:09.7 against the 0:58 written below. The product section is
11.7s over: `comment-and-reply` needs 8s where the clock gives 6, and
`browse-untouched` carries two moments (browse and open, ~5s; the comment and
the answer, ~7s) where the clock gives 4. The edit decides: cut inside the
browse clip, speed the typing, or let the second half of the voice-over start
later. Not captured yet: the two terminal shots (a real Claude Code session,
recorded on a desktop), the phone, and the Runway beats.

## Voice-over, timed (horizontal, 0:58)

~105 words. Read at a talking pace, not an announcer's; leave the gaps where
the clock leaves them. Every line is a claim the app makes for real.

```
0:00  (the chime — the agent-finished notification. No words.)
0:02  One of your agents just finished.
0:04  And it wants a review.
0:09  Wherever that finds you.
0:15  The agent left you a link.
0:18  GitWarren. GitHub-style code review, on your own machines.
0:22  It shows you the change before it's a commit —
0:26  — and you can talk to your agent right on the line.
0:32  Comment on a file the change didn't touch.
0:36  And reach the repos on your other machines, over your own tailnet.
0:40  No account. No server. Nothing leaves your computers.
0:44  Send it back.
0:50  GitWarren is free and open source.
0:53  Desktop, command line, or a browser tab. Mac, Windows, Linux.
      Works with any agent.
0:58  (out)
```

## Storyboard, horizontal (16:9, 1920×1080)

| Ends | Shot | Source | Notes |
|-----:|------|--------|-------|
| 0:10 | **Five people, one by one.** The home desk, the café, the laundry, the dog park, the airport gate — two seconds each, everyone absorbed in their own thing. Music only. | Runway A–E, the first phase of each clip | Cut on movement; no VO yet. |
| 0:12 | **The grid.** All five on screen at once in a split-screen mosaic. The chime. All five react in the same instant — head turns, phones lifted, the laptop opened. | Runway A–E, each clip's reaction aligned on the chime | The VO's first two lines land here. |
| 0:16 | **Push into the traveller.** The grid gives way to E full-frame as he opens the MacBook; push into the screen until it fills the frame: a real terminal, Claude Code, last lines a summary and a `http://127.0.0.1:41427/...` review link. | E plate + terminal recording, composited | Terminal recorded for real (`screencapture -v`), big font, dark theme. Corner-pinned into E's open screen in Resolve, then a hard cut to the full-frame recording. |
| 0:22 | **Click the link → review opens.** Browser, the review's Files changed tab, branch header with the amber *uncommitted* badge. Drawn cursor. | CDP capture, wide | `record.mjs` + `overlay.mjs`, page shot at 1440 and delivered at 1920 as the DHH clip was. |
| 0:26 | **Scroll the diff.** Two or three hunks of a change that reads well in three seconds. Caption: *staged, unstaged and untracked — before it's a commit*. | CDP capture, wide | |
| 0:30 | **A comment on a line.** Cursor to the gutter, click, type a short real comment, post. | CDP capture, wide | The comment text is in the seed; something a reviewer would actually say. |
| 0:32 | **The agent replies in the thread.** Reply appears under the comment, agent identity visible. | CDP capture, wide | `demo-agent-reply.ts` posts it while recording. |
| 0:36 | **Browse files.** Open the repository tree, filter to a file the diff never touched, open it, leave a comment on a line. Caption: *any file in the repo, not just the change*. | CDP capture, wide | Same beat as the DHH clip's browse tab. |
| 0:40 | **Hosts.** The Hosts screen with `pc-win` reachable on the tailnet, then its repositories listed from the Mac. Caption: *your other machines, over your tailnet*. | CDP capture, wide | pc-win must be running GitWarren for real; see setup. |
| 0:44 | **The phone.** Filmed: a real phone, the review from 0:22 open in Safari at the pc-win tailnet URL, thumb scrolls the diff, the comment thread from 0:30 is there. | Filmed | The most credible four seconds in the piece. Daylight, hand-held, no tripod polish. |
| 0:47 | **Back in the terminal.** Typing `left some comments in gitwarren, please check` and Enter; the agent starts reading the review. | Terminal recording | Same session as 0:18. |
| 0:50 | **The grid again.** All five, devices going down, everyone back to their own thing. | Runway A–E, the reaction run backwards or each clip's tail | The same clips as 0:12, not new generations. |
| 0:53 | **Home desk, bookend.** A alone, back at the keyboard. | Runway, beat A | The same clip as the opening; consistency for free. |
| 0:58 | **End card.** Logo, `gitwarren.com`. Under it: *free · GPL-3 · macOS, Windows, Linux · desktop, CLI, web · works with any agent*. | Static, `build-social-preview.mjs` style | Hold 5s; the VO's last line runs over it. |

Sound: the chime at 0:00 and, quieter, as the sting into 0:18 and 0:44. Music
bed ducks under VO. Captions burned in throughout; autoplay is muted everywhere
this will run.

## Storyboard, vertical (9:16, 1080×1920, 0:25)

The phone *is* the product footage here: the product beats are **iOS screen
recordings** of Safari on the real phone, at the tailnet URL — already 9:16,
already real. A CDP capture at a narrow viewport (`record.mjs` takes a
`width`) is the fallback if a recording turns out illegible or needs the drawn
cursor and captions.

| Ends | Shot | Source |
|-----:|------|--------|
| 0:04 | Three people, one after another, absorbed: home desk, dog park, café. | Runway A, D, B — 9:16 |
| 0:07 | The three stacked; the chime; all react. VO: *One of your agents just finished. Wherever that finds you.* | Runway A, D, B — 9:16, reactions aligned |
| 0:11 | Push into the café guest as she lifts the phone, screen to camera; the phone screen becomes the filmed phone or a screen recording: GitWarren at the tailnet URL, the review tapped, it opens. VO: *GitWarren. GitHub-style review, on your own machines.* | B plate + phone footage, composited |
| 0:14 | Screen recording: scroll the diff, amber badge. VO: *Before it's a commit.* | Phone screen recording |
| 0:18 | Screen recording: comment, agent reply. VO: *Talk to your agent on the line.* | Phone screen recording |
| 0:21 | Screen recording: Hosts, pc-win. VO: *Even the box in the other room. No account, no server.* | Phone screen recording |
| 0:25 | End card. VO: *Free and open source. gitwarren.com.* | Static, 9:16 |

## Runway — the five people

Five people, each doing something they like, each getting the same
notification at the same moment. Shown one by one for a beat, then together
in a split-screen grid; the chime; all five react at once. One of them is
followed into the product: the airport traveller opens a MacBook (16:9), the
café guest lifts a phone (9:16), and the edit pushes into that screen.

People and faces are in - people like looking at people. So: warm, positive,
ordinary situations; relaxed expressions; eyes on what they are doing, never
on the camera. Every clip is **one shot in two phases**: their own thing,
then, in the last seconds, the reaction - a head turn, a reach, a small
smile. Big enough to read in a panel a fifth of the screen wide.

**Per beat:** the 16:9 still (Gen-4 Image / Nano Banana Pro, 4 candidates,
keep one); the 9:16 still from the same prompt with the 16:9 keeper in the
reference slot, so it is the same person in the same place; then
image-to-video on each keeper with the motion prompt, **10 seconds** - a 5s
clip front-loads the reaction and leaves nothing to cut with. Three takes,
vary the seed. Same image model and same video model for all five.

**Framing rule in every still:** medium shot, subject centred with room
around them, so the frame crops to a near-square panel without losing the
face or the device. The device is visible before the reaction: a phone on
the table or in a pocket, a closed laptop on a lap.

**Reject** a take with a face that drifts or goes uncanny, a hand or device
that morphs, legible text on a screen, slow motion, a mid-clip cut, or a
reaction that happens too early to align with the others.

```
A  Home desk                                       (16:9 and 9:16)
   still   Calm, professional home computer setup. A programmer seated in
           front of a MacBook, an additional ultrawide monitor. Screens
           show a dark code editor, soft and out of focus, no legible text.
           Medium shot, subject centred with room around them, relaxed,
           eyes on the screen, not on the camera. Slight film grain, shallow
           depth of field, photographic, natural colour, no lens flares.
   motion  One continuous shot, a single take, no cuts, no transitions. The
           camera holds one position and pushes in very slowly and
           steadily; focus stays fixed. They type, unhurried; in the last
           seconds they stop, look at the MacBook, and lean in slightly with
           a small smile.

B  Café                                            (vertical hero)
   still   A woman in her thirties at a café table by a window, laughing
           mid-conversation with a friend whose back is to the camera. A
           flat white and a phone face-up on the table in front of her.
           Medium shot at table height, subject centred with room around
           her, the café soft behind. Warm window light. Natural, relaxed
           expression, not looking at the camera. Slight film grain, shallow
           depth of field, photographic, natural colour, no lens flares.
           [9:16, with the 16:9 keeper as reference: same woman, same café,
           same light and grain, framed vertical - the table and phone in
           the lower third, her face in the upper half.]
   motion  One continuous shot, a single take, no cuts, no transitions. The
           camera holds one position and pushes in very slowly and
           steadily; focus stays fixed. She laughs and talks with her
           friend; in the last seconds the phone on the table lights up,
           she glances down with a small smile, picks it up and lifts it so
           its screen faces the camera.

C  Laundry
   still   A man in his forties folding warm laundry on a table in a small,
           bright laundry room, afternoon light from a high window, a
           basket beside him, a phone at the table's edge. Medium shot at
           chest height, subject centred with room around him. Content,
           relaxed expression, eyes on the folding, not on the camera.
           Slight film grain, shallow depth of field, photographic, natural
           colour, no lens flares.
           [9:16, with reference: same man, same room, same light and
           grain, framed vertical - the table and phone in the lower third,
           his face in the upper half.]
   motion  One continuous shot, a single take, no cuts, no transitions. The
           camera holds one position and pushes in very slowly and
           steadily; focus stays fixed. He folds a towel and sets it on the
           pile; in the last seconds the phone at the table's edge lights
           up, he looks over at it, smiles slightly and picks it up.

D  Dog park
   still   A young woman in a park on an overcast morning, crouched to
           greet a golden retriever, one hand on the dog, a phone in her
           jacket pocket. Medium shot at hip height, subject centred with
           room around her, grass and path soft behind. Happy, relaxed
           expression, eyes on the dog, not on the camera. Cool daylight.
           Slight film grain, shallow depth of field, photographic, natural
           colour, no lens flares.
           [9:16, with reference: same woman and dog, same park, same
           light and grain, framed vertical - the dog low in the frame, her
           face in the upper half.]
   motion  One continuous shot, a single take, no cuts, no transitions. The
           camera holds one position and pushes in very slowly and
           steadily; focus stays fixed. She ruffles the dog's fur and it
           wags; in the last seconds she pauses, takes the phone from her
           jacket pocket, looks at it and smiles.

E  Airport gate                                    (horizontal hero, 10s)
   still   A man in his thirties relaxed in an airport gate seating row,
           a coffee in one hand, looking out of the big windows at a plane
           at the jet bridge, a closed MacBook on his lap. Camera at seat
           height, beside him and slightly behind, so his face is in
           three-quarter profile and the laptop, once open, will face the
           camera. Medium shot, subject centred with room around him.
           Calm expression, not looking at the camera. Flat daylight.
           Slight film grain, shallow depth of field, photographic, natural
           colour, no lens flares.
           [9:16, with reference: same man, same gate, same light and
           grain, framed vertical - the closed laptop on his lap in the
           lower half, his face in the upper half, tall windows above.]
   motion  One continuous shot, a single take, no cuts, no transitions. The
           camera holds one position and pushes in very slowly and
           steadily; focus stays fixed. He sips the coffee and watches the
           plane; in the last seconds he looks down, opens the laptop lid
           and looks at the screen, which is dark and out of focus, facing
           the camera.
```

The reverse montage near the end is the same grid, run from each clip's
reaction backwards or from its tail: devices going down, everyone back to
their own thing. The bookend is A's clip again.

## Product captures — setup

Everything the DHH clip needed, plus the phone and the terminal:

- Demo repositories and a seeded database at `DEMO_REPO_ROOT=~/Developer/klarluft`,
  `DEMO_TAILNET_HOST=pc-win.tail688c0c.ts.net:41427` (`make-demo-repos.sh`,
  then `seed-demo.ts`). The port is explicit on purpose: with the link port
  moved (next point) a bare hostname would normalise to the moved port.
  `set-host-target.ts` repairs a database seeded without it.
- pc-win running GitWarren; otherwise the Hosts card says "stopped responding"
  (tailscale serve there answers 502). The desktop app is no longer installed
  on pc-win, so it is `npx gitwarren@<version> serve` against the data dir the
  app left behind - started through WMI (`Invoke-CimMethod Win32_Process
  Create`), because a process started from an SSH session dies with it.
- The installed Mac app holds 41427: `LINK_SERVER_PORT = 41428` in
  `src/shared/link-port.ts` for the capture, reverted after. `serve.sh` starts
  serve with `__APP_VERSION__` set to pc-win's version, or the card offers a
  "0.0.0-dev" update.
- A dev build rewrites `~/.gitwarren/bin/gitwarren-mcp` to itself; point it
  back at `/Applications/GitWarren.app/...` when done.
- Chrome from a script file with `--remote-debugging-port=9222
  --user-data-dir=<scratch>`; the worktree guard refuses the quoted app path
  inline.
- Terminal shots: a real Claude Code session in a Terminal window sized
  1920×1080, font ~18pt, dark theme, recorded with `screencapture -v`. The
  GitWarren plugin installed so the summary ends with the review link for
  real.
- The phone: Safari at `http://pc-win.tail688c0c.ts.net:41427` (or the Mac's
  tailnet URL), opened on the same review the wide capture used, so the
  comment thread on the phone is the one from 0:30. Two things from it: the
  **filmed** take (a camera on the hand holding the phone, daylight, 4K, one
  continuous scroll to the thread) with an iOS screen recording running
  underneath as insurance, and separate clean **screen recordings** for the
  vertical cut: open the review, scroll the diff, comment and reply, Hosts.

Outputs: `video-out/ad/` (gitignored) — `wide-*.mp4` and `narrow-*.mp4` per
beat, `end-card-16x9.png`, `end-card-9x16.png`, and `rough.mp4`, an ffmpeg
assembly of the product beats on the VO clock as a timing reference for the
Resolve cut.
