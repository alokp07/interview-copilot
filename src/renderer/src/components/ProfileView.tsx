/**
 * Interview context. Everything here is optional — the app works without it —
 * but it is what separates a generic answer from one that sounds like this
 * candidate. Held in memory only, never written to disk.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Field, Label, Select, TextArea, TextInput } from './primitives'
import { useStore } from '../state/store'
import { EMPTY_PROFILE, type CandidateProfile, type InterviewMode } from '@shared/types'

const MODES: Array<{ value: InterviewMode; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'technical', label: 'Technical' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'system-design', label: 'System design' },
  { value: 'coding', label: 'Coding' },
  { value: 'hr', label: 'HR / screening' },
]

export function ProfileView(): ReactNode {
  const stored = useStore((s) => s.profile)
  const setStored = useStore((s) => s.setProfile)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const showToast = useStore((s) => s.showToast)

  const [draft, setDraft] = useState<CandidateProfile>(stored)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(stored)
    setDirty(false)
  }, [stored])

  const update = (key: keyof CandidateProfile, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    await window.cue.setProfile(draft)
    setStored(draft)
    setDirty(false)
    showToast('info', 'Profile applied to this session.')
  }

  return (
    // Scroll region and action bar are siblings, so the buttons sit on a solid
    // footer instead of floating over the fields as a sticky element.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <Label>Interview</Label>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Mode" hint="Shapes how answers are structured.">
          <Select
            value={settings?.session.mode ?? 'general'}
            options={MODES}
            onChange={(mode) => {
              if (!settings) return
              void window.cue
                .setSettings({ session: { ...settings.session, mode } })
                .then(setSettings)
            }}
          />
        </Field>
        <Field label="Answer length">
          <Select
            value={settings?.session.answerLength ?? 'normal'}
            options={[
              { value: 'brief', label: 'Brief (25–45 words)' },
              { value: 'normal', label: 'Normal (45–90 words)' },
              { value: 'detailed', label: 'Detailed (90–160)' },
            ]}
            onChange={(answerLength) => {
              if (!settings) return
              void window.cue
                .setSettings({ session: { ...settings.session, answerLength } })
                .then(setSettings)
            }}
          />
        </Field>
      </div>

      <Label>Candidate</Label>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <TextInput value={draft.name} onChange={(v) => update('name', v)} placeholder="Alok" />
        </Field>
        <Field label="Experience">
          <TextInput
            value={draft.yearsExperience}
            onChange={(v) => update('yearsExperience', v)}
            placeholder="3 years"
          />
        </Field>
      </div>

      <Field label="Role you're interviewing for">
        <TextInput
          value={draft.role}
          onChange={(v) => update('role', v)}
          placeholder="Senior Full-Stack Engineer"
        />
      </Field>

      <Field label="Company">
        <TextInput value={draft.company} onChange={(v) => update('company', v)} />
      </Field>

      <Field label="Skills" hint="Comma-separated. Also used to bias speech recognition.">
        <TextArea
          value={draft.skills}
          onChange={(v) => update('skills', v)}
          rows={2}
          placeholder="React, Node.js, Python, MongoDB, AI systems"
        />
      </Field>

      <Field label="Projects" hint="Short descriptions the model can draw concrete examples from.">
        <TextArea
          value={draft.projects}
          onChange={(v) => update('projects', v)}
          rows={4}
          placeholder="AI visual novel app — Next.js + Claude, streaming story generation&#10;PDF-to-podcast — Python, TTS pipeline"
        />
      </Field>

      <Field label="Job description">
        <TextArea value={draft.jobDescription} onChange={(v) => update('jobDescription', v)} rows={4} />
      </Field>

      <Field label="Resume" hint="Pasted text. Trimmed automatically to keep prompts small and fast.">
        <TextArea value={draft.resume} onChange={(v) => update('resume', v)} rows={5} />
      </Field>

      <Field label="Custom instructions" hint="e.g. 'Mention the fintech background when relevant.'">
        <TextArea value={draft.notes} onChange={(v) => update('notes', v)} rows={2} />
      </Field>

      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2">
        <Button tone="primary" onClick={() => void save()} disabled={!dirty}>
          {dirty ? 'Apply' : 'Applied'}
        </Button>
        <Button
          tone="danger"
          onClick={() => {
            setDraft({ ...EMPTY_PROFILE })
            setDirty(true)
          }}
        >
          Clear
        </Button>
        <span className="ml-auto text-[10px] text-fg-faint">Memory only · wiped on quit</span>
      </div>
    </div>
  )
}
