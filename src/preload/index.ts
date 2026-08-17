/**
 * The preload bridge — the only path between renderer and main.
 *
 * Channels are whitelisted rather than forwarded generically: the renderer can
 * reach exactly the operations below and nothing else, and it never sees an API
 * key. Provider credentials stay in the main process, which is also where the
 * network connections to Deepgram and the LLM live.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE, PUSH, SEND } from '@shared/ipc'
import type { PushMap, ShortcutAction } from '@shared/ipc'
import type {
  AnswerNudge,
  AppSettings,
  CandidateProfile,
  CredentialStatus,
  SessionConfig,
  SessionState,
  StreamId,
  UiSettings,
} from '@shared/types'

const PUSH_CHANNELS = new Set<string>(Object.values(PUSH))

const api = {
  // --- hot path ------------------------------------------------------------
  /**
   * One 2560-byte linear16 frame. `send` rather than `invoke`: a reply would
   * put a round trip on the audio path for no reason.
   */
  sendAudioFrame(stream: StreamId, frame: ArrayBuffer): void {
    ipcRenderer.send(SEND.audioFrame, { stream, frame })
  },
  sendCaptureState(stream: StreamId, state: string, error?: string): void {
    ipcRenderer.send(SEND.captureState, { stream, state, error })
  },

  // --- session -------------------------------------------------------------
  startSession: (config: SessionConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(INVOKE.sessionStart, config),
  stopSession: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(INVOKE.sessionStop),
  getSessionState: (): Promise<SessionState> => ipcRenderer.invoke(INVOKE.sessionState),
  clearSession: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(INVOKE.clearSession),

  // --- profile -------------------------------------------------------------
  getProfile: (): Promise<CandidateProfile> => ipcRenderer.invoke(INVOKE.profileGet),
  setProfile: (profile: CandidateProfile): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(INVOKE.profileSet, profile),
  autofillProfile: (
    resume: string
  ): Promise<{ ok: boolean; fields?: Partial<CandidateProfile>; error?: string }> =>
    ipcRenderer.invoke(INVOKE.profileAutofill, { resume }),

  // --- settings ------------------------------------------------------------
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(INVOKE.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(INVOKE.settingsSet, patch),
  applyOverlay: (ui: Partial<UiSettings>): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(INVOKE.overlayApply, ui),
  hideOverlay: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(INVOKE.overlayHide),
  quit: (): Promise<void> => ipcRenderer.invoke(INVOKE.overlayQuit),

  // --- credentials ---------------------------------------------------------
  getCredentialStatus: (): Promise<CredentialStatus> =>
    ipcRenderer.invoke(INVOKE.credentialsStatus),
  setCredentials: (updates: Record<string, string>): Promise<CredentialStatus> =>
    ipcRenderer.invoke(INVOKE.credentialsSet, updates),

  // --- answers -------------------------------------------------------------
  askManual: (text: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(INVOKE.askManual, { text }),
  regenerate: (nudge?: AnswerNudge): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(INVOKE.answerRegenerate, nudge ? { nudge } : undefined),
  cancelAnswer: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(INVOKE.answerCancel),

  // --- diagnostics ---------------------------------------------------------
  exportTraces: (): Promise<{ path: string | null }> => ipcRenderer.invoke(INVOKE.tracesExport),

  // --- events --------------------------------------------------------------
  /** Returns an unsubscribe function; the renderer must call it on unmount. */
  on<K extends keyof PushMap & string>(
    channel: K,
    handler: (payload: PushMap[K]) => void
  ): () => void {
    if (!PUSH_CHANNELS.has(channel)) {
      throw new Error(`Refusing to subscribe to unknown channel "${channel}"`)
    }
    const listener = (_event: IpcRendererEvent, payload: PushMap[K]): void => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  channels: { PUSH, INVOKE, SEND },
  platform: process.platform,
} as const

export type CueApi = typeof api
export type { ShortcutAction }

contextBridge.exposeInMainWorld('cue', api)
