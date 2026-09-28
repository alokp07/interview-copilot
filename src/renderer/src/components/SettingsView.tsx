/**
 * Providers, latency tuning, window behaviour and credentials.
 *
 * The eager-threshold slider is the interesting control: it trades discarded
 * generations for head start, and the copy says so, because the right value
 * depends on how the interviewer speaks.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Field, Label, Select, TextInput, Toggle } from './primitives'
import { useStore } from '../state/store'
import { LLM_PROVIDERS, modelsFor } from '@shared/models'
import type { AccentColor, AppSettings } from '@shared/types'

const PROVIDER_OPTIONS = LLM_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'Follow system' },
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
]

const ACCENTS: Array<{ id: AccentColor; label: string; swatch: string }> = [
  { id: 'blue', label: 'Blue', swatch: '#5b8cff' },
  { id: 'violet', label: 'Violet', swatch: '#8b5cf6' },
  { id: 'emerald', label: 'Emerald', swatch: '#10b981' },
  { id: 'amber', label: 'Amber', swatch: '#f59e0b' },
  { id: 'rose', label: 'Rose', swatch: '#f43f5e' },
]

const LISTEN_OPTIONS = [
  { value: 'manual' as const, label: 'Manual — I press to listen' },
  { value: 'always' as const, label: 'Always — answer every question' },
]

const CREDENTIAL_FIELDS: Array<{ key: string; label: string; provider: keyof CredentialFlags }> = [
  { key: 'DEEPGRAM_API_KEY', label: 'Deepgram (speech)', provider: 'deepgram' },
  { key: 'GROQ_API_KEY', label: 'Groq', provider: 'groq' },
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', provider: 'openrouter' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', provider: 'openai' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', provider: 'anthropic' },
]

interface CredentialFlags {
  deepgram: boolean
  groq: boolean
  openrouter: boolean
  openai: boolean
  anthropic: boolean
}

export function SettingsView(): ReactNode {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const credentials = useStore((s) => s.credentials)
  const setCredentials = useStore((s) => s.setCredentials)
  const showToast = useStore((s) => s.showToast)

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.cue.getCredentialStatus().then(setCredentials)
  }, [setCredentials])

  if (!settings) return <div className="p-3 text-xs text-fg-faint">Loading…</div>

  const patch = (next: Partial<AppSettings>): void => {
    void window.cue.setSettings(next).then(setSettings)
  }

  const provider = settings.providers.llmProvider
  const models = modelsFor(provider).map((m) => ({
    value: m.id,
    label: `${m.label} — ${m.note}`,
  }))

  const saveKeys = async (): Promise<void> => {
    const updates = Object.fromEntries(
      Object.entries(keyDrafts).filter(([, v]) => v.trim().length > 0)
    )
    if (Object.keys(updates).length === 0) return
    try {
      const status = await window.cue.setCredentials(updates)
      setCredentials(status)
      setKeyDrafts({})
      showToast('info', 'Keys saved and encrypted with your OS keychain.')
    } catch (err) {
      showToast('error', (err as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
      <section>
        <Label>Model</Label>
        {/* Stacked, not side by side: model labels carry their measured latency,
            which is the whole point of showing them and does not fit in half a row. */}
        <div className="flex flex-col gap-2">
          <Field label="Provider">
            <Select
              value={provider}
              options={PROVIDER_OPTIONS}
              onChange={(llmProvider) =>
                patch({
                  providers: {
                    ...settings.providers,
                    llmProvider,
                    // Switching provider must also move to a model that
                    // provider actually serves.
                    llmModel: modelsFor(llmProvider)[0]?.id ?? '',
                  },
                })
              }
            />
          </Field>
          <Field label="Model">
            <Select
              value={settings.providers.llmModel}
              options={models}
              onChange={(llmModel) => patch({ providers: { ...settings.providers, llmModel } })}
            />
          </Field>
        </div>
      </section>

      <section>
        <Label>Answering</Label>
        <Field
          label="When to answer"
          hint="Manual keeps Cue silent until you hold the listen button or arm it (Ctrl+Shift+A) — so it never answers chit-chat or half-heard audio. Always answers every detected question."
        >
          <Select
            value={settings.session.listenMode}
            options={LISTEN_OPTIONS}
            onChange={(listenMode) => patch({ session: { ...settings.session, listenMode } })}
          />
        </Field>
        <div className="mt-1">
          <Toggle
            label="Fall back to another provider on failure"
            hint="If the primary model fails before an answer starts, automatically retry with another provider you've configured."
            checked={settings.session.providerFallback}
            onChange={(providerFallback) =>
              patch({ session: { ...settings.session, providerFallback } })
            }
          />
        </div>
      </section>

      <section>
        <Label>Appearance</Label>
        <Field label="Theme">
          <Select
            value={settings.ui.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => patch({ ui: { ...settings.ui, theme } })}
          />
        </Field>
        <div className="mt-2">
          <span className="mb-1.5 block text-[11px] font-medium text-fg-muted">Accent</span>
          <div className="flex items-center gap-2">
            {ACCENTS.map((a) => {
              const active = settings.ui.accent === a.id
              return (
                <button
                  key={a.id}
                  type="button"
                  title={a.label}
                  aria-label={a.label}
                  aria-pressed={active}
                  onClick={() => patch({ ui: { ...settings.ui, accent: a.id } })}
                  className={`no-drag h-6 w-6 rounded-full transition-transform duration-100 hover:scale-110 ${
                    active ? 'ring-2 ring-fg ring-offset-2 ring-offset-base' : ''
                  }`}
                  style={{ background: a.swatch }}
                />
              )
            })}
          </div>
        </div>
      </section>

      <section>
        <Label>Latency</Label>
        <Toggle
          label="Answer before the question finishes"
          hint="Starts generating on a predicted end-of-turn, then keeps the answer if the prediction held. This is what produces sub-second — sometimes negative — response times."
          checked={settings.session.speculative}
          onChange={(speculative) => patch({ session: { ...settings.session, speculative } })}
        />

        <div className="mt-2">
          <Field
            label={`Prediction threshold — ${settings.providers.eagerEotThreshold.toFixed(2)}`}
            hint="Lower reacts sooner but discards more work. 0.4 is a good default."
          >
            <input
              type="range"
              min={0.3}
              max={0.9}
              step={0.05}
              value={settings.providers.eagerEotThreshold}
              onChange={(e) =>
                patch({
                  providers: {
                    ...settings.providers,
                    eagerEotThreshold: Number(e.target.value),
                  },
                })
              }
              className="no-drag w-full accent-[var(--color-accent)]"
            />
          </Field>
        </div>

        <div className="mt-2">
          <Field
            label={`End-of-turn confidence — ${settings.providers.eotThreshold.toFixed(2)}`}
            hint="Higher waits for more certainty before committing to an answer."
          >
            <input
              type="range"
              min={0.5}
              max={0.9}
              step={0.05}
              value={settings.providers.eotThreshold}
              onChange={(e) =>
                patch({
                  providers: { ...settings.providers, eotThreshold: Number(e.target.value) },
                })
              }
              className="no-drag w-full accent-[var(--color-accent)]"
            />
          </Field>
        </div>
      </section>

      <section>
        <Label>Window</Label>
        <Toggle
          label="Hide from screen sharing"
          hint="Excludes this window from screen capture at the OS compositor level. Requires Windows 10 2004 or newer."
          checked={settings.ui.contentProtection}
          onChange={(contentProtection) => patch({ ui: { ...settings.ui, contentProtection } })}
        />
        <Toggle
          label="Always on top"
          checked={settings.ui.alwaysOnTop}
          onChange={(alwaysOnTop) => patch({ ui: { ...settings.ui, alwaysOnTop } })}
        />
        <Toggle
          label="Show live transcript"
          checked={settings.ui.showTranscript}
          onChange={(showTranscript) => patch({ ui: { ...settings.ui, showTranscript } })}
        />
        <Toggle
          label="Show latency readout"
          checked={settings.ui.showLatency}
          onChange={(showLatency) => patch({ ui: { ...settings.ui, showLatency } })}
        />
        <div className="mt-2">
          <Field label={`Opacity — ${Math.round(settings.ui.opacity * 100)}%`}>
            <input
              type="range"
              min={0.25}
              max={1}
              step={0.05}
              value={settings.ui.opacity}
              onChange={(e) => patch({ ui: { ...settings.ui, opacity: Number(e.target.value) } })}
              className="no-drag w-full accent-[var(--color-accent)]"
            />
          </Field>
        </div>
      </section>

      <section>
        <Label>API keys</Label>
        <p className="mb-2 text-[10px] text-fg-faint">
          Encrypted with your OS keychain (DPAPI on Windows) and only ever read by the background
          process. Leave a field blank to keep the existing key.
        </p>
        <div className="flex flex-col gap-2">
          {CREDENTIAL_FIELDS.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              hint={credentials?.[field.provider] ? 'Configured' : 'Not set'}
            >
              <TextInput
                type="password"
                value={keyDrafts[field.key] ?? ''}
                placeholder={credentials?.[field.provider] ? '••••••••••••' : 'Paste key'}
                onChange={(v) => setKeyDrafts((d) => ({ ...d, [field.key]: v }))}
              />
            </Field>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <Button tone="primary" onClick={() => void saveKeys()}>
            Save keys
          </Button>
          <Button
            onClick={() =>
              void window.cue.exportTraces().then((r) => {
                showToast(
                  r.path ? 'info' : 'warn',
                  r.path ? `Latency traces written to ${r.path}` : 'No traces recorded yet.'
                )
              })
            }
          >
            Export latency log
          </Button>
        </div>
      </section>

      <section className="pb-2">
        <Label>Shortcuts</Label>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px] text-fg-faint">
          {[
            ['Start / stop session', 'Ctrl+Shift+Space'],
            ['Arm listening (next question)', 'Ctrl+Shift+A'],
            ['Hide / show window', 'Ctrl+Shift+H'],
            ['Regenerate answer', 'Ctrl+Shift+R'],
            ['Clear session', 'Ctrl+Shift+X'],
            ['Cycle opacity', 'Ctrl+Shift+O'],
          ].map(([label, key]) => (
            <div key={key} className="contents">
              <dt>{label}</dt>
              <dd className="font-mono text-fg-muted">{key}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
