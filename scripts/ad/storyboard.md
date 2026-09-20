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
| 0:03 | **Dark room.** A desk at night, laptop open, screen glow the only light. The chime; a hand comes into frame and reaches for the trackpad. | Runway, beat A | Also the bookend and the plate for the zoom at 0:15. Generate this one first; keep the best take. |
| 0:06 | **Café.** A phone face-down on a table beside a cup; the hand turns it over and lifts it. | Runway, beat B | |
| 0:09 | **Laundry.** A phone pulled from a back pocket with one hand, the other holding a basket or a folded towel. | Runway, beat C | |
| 0:12 | **Dog park.** Leash in one hand, phone raised in the other; the dog pulls a little. | Runway, beat D | |
| 0:15 | **Airport gate.** Laptop half-open on a knee, boarding pass on the seat beside; the lid opens the rest of the way. | Runway, beat E | |
| 0:18 | **Zoom into the dark-room screen.** Push in on beat A's laptop until the screen fills frame; the screen is a real terminal: Claude Code, last lines a summary and a `http://127.0.0.1:41427/...` review link. | Beat A plate + terminal recording, composited | Terminal recorded for real (`screencapture -v`), big font, dark theme. Corner-pinned into the plate in Resolve, then a hard cut to the full-frame recording. |
| 0:22 | **Click the link → review opens.** Browser, the review's Files changed tab, branch header with the amber *uncommitted* badge. Drawn cursor. | CDP capture, wide | `record.mjs` + `overlay.mjs`, page shot at 1440 and delivered at 1920 as the DHH clip was. |
| 0:26 | **Scroll the diff.** Two or three hunks of a change that reads well in three seconds. Caption: *staged, unstaged and untracked — before it's a commit*. | CDP capture, wide | |
| 0:30 | **A comment on a line.** Cursor to the gutter, click, type a short real comment, post. | CDP capture, wide | The comment text is in the seed; something a reviewer would actually say. |
| 0:32 | **The agent replies in the thread.** Reply appears under the comment, agent identity visible. | CDP capture, wide | `demo-agent-reply.ts` posts it while recording. |
| 0:36 | **Browse files.** Open the repository tree, filter to a file the diff never touched, open it, leave a comment on a line. Caption: *any file in the repo, not just the change*. | CDP capture, wide | Same beat as the DHH clip's browse tab. |
| 0:40 | **Hosts.** The Hosts screen with `pc-win` reachable on the tailnet, then its repositories listed from the Mac. Caption: *your other machines, over your tailnet*. | CDP capture, wide | pc-win must be running GitWarren for real; see setup. |
| 0:44 | **The phone.** Filmed: a real phone, the review from 0:22 open in Safari at the pc-win tailnet URL, thumb scrolls the diff, the comment thread from 0:30 is there. | Filmed | The most credible four seconds in the piece. Daylight, hand-held, no tripod polish. |
| 0:47 | **Back in the terminal.** Typing `left some comments in gitwarren, please check` and Enter; the agent starts reading the review. | Terminal recording | Same session as 0:18. |
| 0:50 | **Reverse montage, fast.** Dog park, laundry, café — one second each — phones going away, people going back to it. | Runway beats D, C, B — tail ends | Use the tail of each clip, or the clip reversed if the motion reads. |
| 0:53 | **Dark room, bookend.** The same beat A clip; the laptop lid coming down, or the hand leaving frame. | Runway, beat A | Literally the same clip as 0:03, not a second generation — consistency for free. |
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
| 0:02 | Dark room, the chime. | Runway A, 9:16 |
| 0:05 | Café, phone lifted. VO: *One of your agents just finished.* | Runway B, 9:16 |
| 0:07 | Dog park. VO: *Wherever that finds you.* | Runway D, 9:16 |
| 0:11 | Filmed phone (hand in frame): GitWarren open at the tailnet URL, the review tapped, it opens. VO: *GitWarren. GitHub-style review, on your own machines.* | Filmed |
| 0:14 | Screen recording: scroll the diff, amber badge. VO: *Before it's a commit.* | Phone screen recording |
| 0:18 | Screen recording: comment, agent reply. VO: *Talk to your agent on the line.* | Phone screen recording |
| 0:21 | Screen recording: Hosts, pc-win. VO: *Even the box in the other room. No account, no server.* | Phone screen recording |
| 0:25 | End card. VO: *Free and open source. gitwarren.com.* | Static, 9:16 |

## Runway — the five people beats

Still first, then animate the still. Image-to-video is the controllable path:
the still locks composition, framing, light and grade, and the video prompt
then describes one motion. It is also what makes the 16:9 and 9:16 versions
of a beat read as the same place - both start from the same picture, framed
twice. Faces out of frame or soft in every beat; hands, devices, place.

**Order of work, per beat:**

1. Generate the still (Gen-4 Image), in 16:9. 4 candidates; keep one.
2. Generate the same still in 9:16 with the vertical framing line; give it
   the 16:9 keeper as a reference so the place and the grade carry over.
3. Animate each keeper (Gen-4 Turbo, image-to-video, 5s; beat A also 10s)
   with the motion prompt. 2-3 takes; vary the seed, not the prompt.
4. Download the keeper at the highest resolution offered. Upscale beat A's:
   the edit pushes into its screen.

Iterate on Turbo; regenerate a winner on the full model only if Turbo's
hands or fabric fall apart on it. Name files `A-16x9-take2.mp4`,
`B-9x16-still.png`, and so on, in `~/Desktop/gitwarren-ad/runway/`.

**One grade, in every still prompt:** *warm practicals, cool ambient, slight
film grain, shallow depth of field, photographic, no lens flares.* The
model does not remember the last prompt.

**Reject** any take with legible text on a screen, a face in focus, a device
or a hand that morphs between frames, slow motion, or a camera move the
prompt did not ask for.

```
A  Dark room                                       (5s and 10s)
   still   Night. A wooden desk lit only by the glow of an open laptop
           screen, the screen angled toward the camera. Camera at desk
           height, slightly behind the laptop's left edge. The screen shows
           a dark code editor, soft and out of focus, no legible text. A
           person sits behind it, out of focus. Warm screen light, cool dark
           room. + grade
           [16:9: the laptop centred, room around it]
           [9:16: the laptop fills the lower two-thirds, dark wall above]
   motion  A hand enters from the right and settles on the trackpad. Static
           camera with a subtle handheld drift. Nothing else moves.

B  Café
   still   A café table by a window, daytime. A phone lies face-down on the
           wood beside a half-finished flat white. Camera at table height,
           the room soft behind. Warm window light. No people in focus.
           + grade
           [16:9: the table runs across the frame]
           [9:16: the cup low in frame, empty table above]
   motion  A hand turns the phone over and lifts it toward the camera; the
           screen is dark glass. Static camera.

C  Laundry
   still   A small laundry room, afternoon light from a high window. Camera
           at waist height, tight on a person's hands: one holds a folded
           towel against a hip, a phone sits in the back pocket. Washing
           machine door in the left third. Natural soft light. No face in
           frame. + grade
           [16:9: machine left, hands centre]
           [9:16: towel low, empty frame above for the phone to rise into]
   motion  The free hand pulls the phone from the back pocket and raises it
           into frame. Static camera.

D  Dog park
   still   A park path, overcast morning. Camera low, at hip height. One
           hand holds a leash that runs out of frame toward a dog; grass and
           path soft behind. Cool daylight. No face in frame. + grade
           [16:9: the leash leads out of frame to the right]
           [9:16: the leash leads out of the bottom of frame]
   motion  The dog pulls the leash once; the other hand brings a phone up
           into frame. The camera follows slightly, handheld.

E  Airport gate
   still   An airport gate seating row, big windows, a plane at the jet
           bridge far behind and out of focus. A laptop rests half-open on a
           knee, a boarding pass on the seat beside. Camera at seat height.
           Flat daylight. No face in frame. + grade
           [16:9: the row of seats across the frame]
           [9:16: knee and laptop in the lower half, windows above]
   motion  A hand opens the laptop lid the rest of the way. Static camera.
```

The bookend at 0:53 is beat A's clip again, not a second generation. The
reverse montage at 0:47 is the tails of D, C and B, or the clips reversed
where the motion reads.

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
