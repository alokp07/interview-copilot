/**
 * The overlay window.
 *
 * Discretion is a product requirement, and on Windows it is a real OS feature
 * rather than a trick: `setContentProtection(true)` maps to
 * `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, which the desktop
 * compositor honours — the window is absent from screen recordings and shared
 * screens, not merely blacked out. It requires Windows 10 2004 or newer; on
 * older builds the same call degrades to a black rectangle, and on macOS/Linux
 * Electron applies the nearest available equivalent.
 */

import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { createLogger } from '@main/core/logger'
import { getSettings } from '@main/config/settings'
import type { UiSettings } from '@shared/types'

const log = createLogger('overlay')

let overlay: BrowserWindow | null = null

export function getOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export function createOverlay(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(460, Math.floor(workArea.width * 0.34))
  const height = Math.min(760, Math.floor(workArea.height * 0.86))

  const window = new BrowserWindow({
    width,
    height,
    minWidth: 340,
    minHeight: 320,
    // Top-right by default: out of the way of a shared screen's centre.
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#0a0a0c',
    title: 'Cue',
    webPreferences: {
      // Built output is ESM (`"type": "module"`), so `__dirname` does not exist.
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preloads require an unsandboxed renderer. Context isolation and the
      // absence of node integration are what actually keep the renderer walled
      // off, and both remain on.
      sandbox: false,
      // Non-negotiable: a throttled renderer stops pumping audio frames the
      // moment the window is hidden, which is exactly when it must keep working.
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  window.on('ready-to-show', () => {
    applyUiSettings(getSettings().ui)
    window.show()
  })

  // Never navigate away from the app, and send real links to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  window.on('closed', () => {
    overlay = null
  })

  overlay = window
  return window
}

export function applyUiSettings(ui: Partial<UiSettings>): void {
  const window = getOverlay()
  if (!window) return

  if (ui.alwaysOnTop !== undefined) {
    // 'screen-saver' is the level that stays above full-screen meeting clients.
    window.setAlwaysOnTop(ui.alwaysOnTop, 'screen-saver')
    window.setVisibleOnAllWorkspaces(ui.alwaysOnTop, { visibleOnFullScreen: true })
  }

  if (ui.contentProtection !== undefined) {
    window.setContentProtection(ui.contentProtection)
    log.info(`content protection ${ui.contentProtection ? 'on' : 'off'}`)
  }

  if (ui.opacity !== undefined) {
    window.setOpacity(Math.min(1, Math.max(0.25, ui.opacity)))
  }
}

export function hideOverlay(): void {
  // `hide()`, not `minimize()`: the window sets `skipTaskbar`, so a minimized
  // window would have no taskbar button to restore it from. The tray icon and
  // the global shortcut are the ways back.
  getOverlay()?.hide()
}

export function showOverlay(): void {
  const window = getOverlay()
  if (!window) return
  window.show()
  window.focus()
  // Re-assert protection: hiding a window has historically reset the display
  // affinity flag on Windows.
  applyUiSettings(getSettings().ui)
}

export function toggleVisibility(): void {
  const window = getOverlay()
  if (!window) return
  if (window.isVisible()) hideOverlay()
  else showOverlay()
}

export function cycleOpacity(): number {
  const window = getOverlay()
  if (!window) return 1
  const steps = [1, 0.85, 0.65, 0.45]
  const current = window.getOpacity()
  const index = steps.findIndex((s) => Math.abs(s - current) < 0.02)
  const next = steps[(index + 1) % steps.length] ?? 1
  window.setOpacity(next)
  return next
}
