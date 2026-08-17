/**
 * System tray presence.
 *
 * The overlay sets `skipTaskbar`, so once hidden it has no taskbar button and
 * the only way back would be a global shortcut the user has to remember. A tray
 * icon makes hiding safe: there is always something visible to click.
 *
 * The icon is drawn as an inline SVG data URL rather than shipped as a file, so
 * there is no build-time asset path to get wrong between dev and a packaged app.
 */

import { app, Menu, nativeImage, Tray } from 'electron'
import { createLogger } from '@main/core/logger'
import { getOverlay, hideOverlay, showOverlay } from '@main/windows/overlay'

const log = createLogger('tray')

let tray: Tray | null = null

/** A filled dot inside a ring — reads clearly at 16px in both tray themes. */
const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="12" fill="none" stroke="#5b8cff" stroke-width="3"/>
  <circle cx="16" cy="16" r="5" fill="#5b8cff"/>
</svg>`

export function createTray(): void {
  if (tray) return

  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString('base64')}`
  )

  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }))
  } catch (err) {
    // A missing tray is inconvenient, not fatal — the shortcut still works.
    log.warn('could not create tray icon', err)
    return
  }

  tray.setToolTip('Cue — interview copilot')
  refreshMenu()

  // Click toggles, matching what people expect from a tray utility.
  tray.on('click', () => {
    const window = getOverlay()
    if (window?.isVisible()) hideOverlay()
    else showOverlay()
    refreshMenu()
  })
}

export function refreshMenu(): void {
  if (!tray) return
  const visible = getOverlay()?.isVisible() ?? false

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? 'Hide Cue' : 'Show Cue',
        accelerator: 'CommandOrControl+Shift+H',
        click: () => {
          if (visible) hideOverlay()
          else showOverlay()
          refreshMenu()
        },
      },
      { type: 'separator' },
      { label: 'Quit Cue', click: () => app.quit() },
    ])
  )
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
