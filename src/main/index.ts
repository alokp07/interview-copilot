/**
 * Main process entry point.
 *
 * Also home to the two OS-level integrations the product depends on:
 * system-audio loopback capture and global shortcuts.
 */

import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, globalShortcut, session as electronSession } from 'electron'
import { createLogger } from '@main/core/logger'
import { primeRedaction } from '@main/config/credentials'
import { getSettings, updateSettings } from '@main/config/settings'
import { createOverlay, cycleOpacity, getOverlay, toggleVisibility } from '@main/windows/overlay'
import { createTray, destroyTray, refreshMenu } from '@main/windows/tray'
import { clearSensitiveState, pushShortcut, registerIpc } from '@main/ipc/handlers'
import { disposeProviders } from '@main/providers/factory'
import type { ShortcutAction } from '@shared/ipc'

const log = createLogger('main')

// A single instance owns the global shortcuts and the audio devices; a second
// one would silently fight the first for both.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setAppUserModelId('com.cue.interviewcopilot')

// Chromium's built-in echo cancellation would treat the interviewer's voice as
// echo to be removed. We want it verbatim, and we do our own channel routing.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')

function setupMediaAccess(): void {
  const ses = electronSession.defaultSession

  /**
   * System audio capture.
   *
   * On Windows, Chromium can pull the WASAPI loopback stream directly, so
   * `getDisplayMedia()` from the renderer resolves to a stream containing the
   * mixed system output — everything the interviewer says through the meeting
   * app — with no native module involved. We must hand back a video source for
   * the request to be valid; the renderer stops that track immediately, since
   * decoding screen frames would cost real CPU for something we never look at.
   */
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], fetchWindowIcons: false, thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const screenSource = sources[0]
          if (!screenSource) {
            log.error('no screen source available for loopback capture')
            callback({})
            return
          }
          callback({ video: screenSource, audio: 'loopback' })
        })
        .catch((err) => {
          log.error('desktopCapturer failed', err)
          callback({})
        })
    },
    // The system picker would prompt the user on every start; we always want the
    // same thing (whole-system audio), so we resolve it ourselves.
    { useSystemPicker: false }
  )

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    // The renderer is our own code; only media is ever legitimately needed.
    callback(permission === 'media')
  })

  ses.setPermissionCheckHandler((_contents, permission) => permission === 'media')
}

function registerShortcuts(): void {
  const bindings: Array<[string, ShortcutAction | (() => void)]> = [
    ['CommandOrControl+Shift+Space', 'toggle-listening'],
    [
      'CommandOrControl+Shift+H',
      () => {
        toggleVisibility()
        refreshMenu()
      },
    ],
    ['CommandOrControl+Shift+R', 'regenerate'],
    ['CommandOrControl+Shift+X', 'clear'],
    [
      'CommandOrControl+Shift+O',
      () => {
        const opacity = cycleOpacity()
        updateSettings({ ui: { ...getSettings().ui, opacity } })
      },
    ],
  ]

  for (const [accelerator, action] of bindings) {
    const ok = globalShortcut.register(accelerator, () => {
      if (typeof action === 'function') action()
      else pushShortcut(getOverlay(), action)
    })
    // Another app may already own the combination — worth knowing, not fatal.
    if (!ok) log.warn(`could not register shortcut ${accelerator}`)
  }
}

app.whenReady().then(() => {
  primeRedaction()
  setupMediaAccess()

  const window = createOverlay()
  registerIpc(() => getOverlay())
  registerShortcuts()
  // Must come after the window exists: hiding a `skipTaskbar` window leaves the
  // tray as the only visible way back.
  createTray()

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  app.on('second-instance', () => {
    const existing = getOverlay()
    if (existing) {
      existing.show()
      existing.focus()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay()
  })

  log.info('ready')
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  destroyTray()
  disposeProviders()
  clearSensitiveState()
  log.info('shut down')
})
