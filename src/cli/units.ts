/**
 * The three files an operating system reads to start something at login.
 *
 * Strings and paths only - nothing here writes, spawns or asks the OS anything,
 * which is what lets a test assert on the exact bytes that will land in a
 * user's home directory on a platform the test is not running on. `service.ts`
 * next door does the writing and the `launchctl`/`systemctl`/`schtasks` calls.
 *
 * ## Every one of them names the launcher, not the bundle
 *
 * `~/.gitwarren/bin/gitwarren`, never `<install>/bin/node <install>/lib/…`.
 * Three things fall out of that and each is worth the indirection:
 *
 *  - the unit files stay short enough to read, and hold no environment, since
 *    the launcher exports it;
 *  - `service install` after an update rewrites one file rather than
 *    re-registering with three different OS mechanisms;
 *  - `schtasks /TR` has a length limit and no way to set environment
 *    variables, so on Windows the indirection is not a preference.
 *
 * ## Why nothing here restarts a dead daemon
 *
 * launchd's `KeepAlive` and systemd's `Restart=` are the obvious things to
 * reach for, and both are wrong here. `gitwarren serve --listen` has a refusal
 * it is *supposed* to exit on: a data directory has one owner, and if the app
 * is running the daemon stands aside (see `daemon/listen.ts`). Under a restart
 * policy that refusal becomes a process respawning every ten seconds for as
 * long as the user has GitWarren open - burning a little CPU, and writing the
 * same paragraph into a log file until the disk notices. Start at login, and
 * stay stopped if it stops, is the honest behaviour for a thing whose failure
 * mode is "something else is already doing this".
 */

/**
 * The launchd label, the systemd unit name and the Task Scheduler task name.
 *
 * Deliberately not the app's `appId` (`com.gitwarren.app`): a machine can have
 * both, they are different programs with different login items, and a user
 * looking at `launchctl list` should be able to tell which one they are about
 * to unload.
 */
export const LAUNCHD_LABEL = 'com.gitwarren.daemon'
export const SYSTEMD_UNIT = 'gitwarren.service'
export const WINDOWS_TASK = 'GitWarren daemon'

/** The arguments every unit passes, spelled once. */
export const SERVE_ARGS = ['serve', '--listen'] as const

/**
 * `<`, `&` and the rest, for a plist.
 *
 * A path is user data - `~/Library/Application Support` is not, but a
 * `GITWARREN_DATA_DIR` someone chose might be, and a home directory certainly
 * can be. An unescaped `&` does not corrupt the file visibly; it makes launchd
 * reject the whole plist, and the login item simply never runs.
 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The LaunchAgent.
 *
 * `RunAtLoad` and nothing else - see the header on why there is no `KeepAlive`.
 * `ProcessType` is `Background` so the daemon is scheduled like the background
 * work it is rather than competing with whatever the user is looking at, and
 * the two log paths are there because a launchd job's output goes nowhere at
 * all by default: a daemon that refused to start would do so in silence, which
 * is the one failure this file exists to make visible.
 */
export function launchAgent(launcher: string, logPath: string): string {
  const args = [launcher, ...SERVE_ARGS]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

/**
 * The systemd user unit.
 *
 * `WantedBy=default.target` is the user-session equivalent of "at login", and
 * it is the piece that makes this a *user* unit rather than a system one: no
 * root, no `sudo`, and it runs as the person whose repositories these are,
 * which is the only account with any business reading them.
 *
 * Quoted `ExecStart` because systemd splits the line on whitespace and a home
 * directory may contain some; `Type=simple` because the daemon does not fork
 * and never claims to be ready by exiting.
 *
 * Nothing here mentions the loopback port. `After=` on a network target would
 * be superstition: the daemon binds 127.0.0.1, which exists before any of them.
 */
export function systemdUnit(launcher: string): string {
  const command = [launcher, ...SERVE_ARGS].map((value) => `"${value}"`).join(' ')

  return [
    '[Unit]',
    'Description=GitWarren - local code review, served on loopback',
    'Documentation=https://github.com/klarluft/gitwarren-app',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command}`,
    // See the header. A refusal is a reason to stay stopped.
    'Restart=no',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

/**
 * What `schtasks /Create` is handed as `/TR`.
 *
 * One argument holding a whole command line, which the Task Scheduler splits
 * again at run time: first token the program, the rest its arguments. So the
 * launcher is quoted here, because
 * `C:\Users\Some Name\.gitwarren\bin\gitwarren.cmd` has a space in it whenever
 * the user's account name does, and an unquoted one would be read as a program
 * called `C:\Users\Some` with `Name\.gitwarren\…` for an argument.
 *
 * The quotes are written plainly rather than escaped because `service.ts`
 * spawns `schtasks` through `execFileSync` with no shell: the string below is
 * handed over as one `argv` entry and never passes through `cmd`. Escaping for
 * a shell that is not in the path is how a literal backslash ends up inside the
 * stored task.
 */
export function windowsTaskCommand(launcher: string): string {
  return [`"${launcher}"`, ...SERVE_ARGS].join(' ')
}
