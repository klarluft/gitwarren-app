/**
 * The tray icon, which is what "always on" actually looks like to a user.
 *
 * Once closing the window stops quitting the app, there has to be something on
 * screen that says GitWarren is still there and gives a way to bring it back or
 * end it. On Windows and Linux that is the whole of it: with no window and no
 * tray icon, a running GitWarren would be invisible and unkillable except
 * through a task manager. macOS has the dock as well, but the menu bar item is
 * still worth having - the app is commonly running with no window at all, and a
 * dock icon for a window-less app is easy to overlook.
 *
 * Two items and no more. A tray menu is a place features go to hide from the
 * design, and everything else GitWarren does needs a window anyway.
 */
import { app, Menu, nativeImage, Tray } from 'electron'
// The same file electron-builder turns into the .icns/.ico. Resized here rather
// than shipped at several sizes: it is one image, scaled once at startup.
import icon from '../../build/icon.png?asset'

let tray: Tray | null = null

/**
 * How big the icon has to be, per platform.
 *
 * Handing a 512px image to `Tray` gives a comically large or blurry icon
 * depending on the desktop, and every platform wants a different answer. macOS
 * measures the menu bar in points and wants 22 at most; Windows' notification
 * area is 16 logical pixels; the tray implementations on Linux are more
 * forgiving and 22 is the common convention.
 */
function iconSize(): number {
  switch (process.platform) {
    case 'darwin':
      return 18
    case 'win32':
      return 16
    default:
      return 22
  }
}

/**
 * Create the tray icon. Returns whether there is now one on screen.
 *
 * `onOpen` rather than a window reference: whether opening means showing a
 * hidden window or building a new one is `index.ts`'s business, and the tray
 * should not have an opinion about which.
 *
 * Deliberately *not* a template image on macOS. A template image is rendered as
 * a monochrome silhouette, which is right for a glyph and wrong for a logo -
 * GitWarren's would come out as a filled blob. A colour icon in the menu bar is
 * ordinary and is what the app already looks like everywhere else.
 *
 * **Nothing here may throw.** A tray is a nicety on a desktop that has one and
 * an impossibility on a desktop that does not: `new Tray()` needs a
 * StatusNotifierItem host or an XEmbed tray, and plenty of Linux setups - a
 * bare window manager, a stripped-down GNOME, WSLg - have neither. This runs
 * during `whenReady`, ahead of the window, so an exception escaping it would
 * cost the user the window, the updater and the deep-link factory: GitWarren
 * would start, show nothing at all, and have to be killed from a task manager.
 * A missing tray icon is a much smaller problem than that, so it is caught and
 * reported, and the boolean lets the caller make sure the user is left with
 * *something*.
 */
export function createTray(onOpen: () => void): boolean {
  if (tray) return true

  try {
    const size = iconSize()
    const image = nativeImage.createFromPath(icon).resize({ width: size, height: size })

    if (image.isEmpty()) {
      // A Tray built from an empty image is worse than none: some platforms
      // render a blank gap the user cannot see but can click.
      console.error('[tray] could not load the icon; running without a tray item')
      return false
    }

    const created = new Tray(image)
    created.setToolTip('GitWarren')

    const menu = Menu.buildFromTemplate([
      { label: 'Open GitWarren', click: onOpen },
      { type: 'separator' },
      // The only way out now that closing the window does not quit. Labelled
      // with the app name rather than a bare "Quit" because a tray menu is read
      // out of context, next to a dozen other icons.
      { label: 'Quit GitWarren', click: () => app.quit() }
    ])

    created.setContextMenu(menu)

    // A left click opens the window on Windows and Linux, which is what users
    // of every other tray app expect. macOS shows the menu on either button and
    // fires no `click` worth acting on, so it is left alone.
    if (process.platform !== 'darwin') created.on('click', onOpen)

    tray = created
    return true
  } catch (error) {
    console.error('[tray] this desktop has no system tray; running without one', error)
    tray = null
    return false
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
