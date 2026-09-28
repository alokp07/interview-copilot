/**
 * Theme application. The palette is entirely CSS variables (see styles.css), so
 * switching theme or accent is just setting two data attributes on <html> — no
 * React re-render of the tree, no class churn.
 *
 * `system` is resolved to light/dark in JS and re-resolved when the OS flips, so
 * the CSS only ever needs concrete `[data-theme='light'|'dark']` rules.
 */

import type { AccentColor, ThemePreference } from '@shared/types'

const THEME_KEY = 'cue-theme'
const ACCENT_KEY = 'cue-accent'

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return prefersDark() ? 'dark' : 'light'
  return pref
}

let systemListener: ((e: MediaQueryListEvent) => void) | null = null

export function applyTheme(pref: ThemePreference, accent: AccentColor): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(pref)
  root.dataset.accent = accent

  // Remember for the next launch so the correct theme paints before settings
  // arrive over IPC — no dark flash for a light-theme user.
  try {
    localStorage.setItem(THEME_KEY, pref)
    localStorage.setItem(ACCENT_KEY, accent)
  } catch {
    /* private mode / blocked storage — theme still applies for this session */
  }

  // Follow OS changes only while the preference is 'system'.
  let mq: MediaQueryList | null = null
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    mq = null
  }
  if (systemListener && mq) mq.removeEventListener('change', systemListener)
  systemListener = null
  if (pref === 'system' && mq) {
    systemListener = () => {
      document.documentElement.dataset.theme = resolveTheme('system')
    }
    mq.addEventListener('change', systemListener)
  }
}

/**
 * Apply whatever we remembered last, before React renders, so the first paint is
 * already the right theme. Authoritative settings from main override this a beat
 * later via `applyTheme`.
 */
export function bootstrapThemeFromStorage(): void {
  let pref: ThemePreference = 'dark'
  let accent: AccentColor = 'blue'
  try {
    const t = localStorage.getItem(THEME_KEY)
    const a = localStorage.getItem(ACCENT_KEY)
    if (t === 'light' || t === 'dark' || t === 'system') pref = t
    if (a === 'blue' || a === 'violet' || a === 'emerald' || a === 'amber' || a === 'rose') {
      accent = a
    }
  } catch {
    /* fall through to defaults */
  }
  applyTheme(pref, accent)
}
