/**
 * Interview context. Everything here is optional — the app works without it —
 * but it is what separates a generic answer from one that sounds like this
 * candidate. With grounding on, it is also the knowledge boundary: answers may
 * only claim what this page supports. Persisted encrypted on this device
 * (OS keychain); Clear removes it from disk.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Field, Label, Select, TextArea, TextInput, Toggle } from './primitives'
import { useStore } from '../state/store'
import {
  EMPTY_PROFILE,
  type AnswerComplexity,
  type CandidateProfile,
  type InterviewMode,
} from '@shared/types'

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
  const [autofilling, setAutofilling] = useState(false)

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
    showToast('info', 'Profile applied and saved (encrypted on this device).')
  }

  /** Grounding needs material to enforce; used to warn when there is none. */
  const hasSubstance = Boolean(
    draft.skills.trim() || draft.projects.trim() || draft.workExperience.trim() || draft.resume.trim()
  )

  const autofill = async (): Promise<void> => {
    setAutofilling(true)
    try {
      const result = await window.cue.autofillProfile(draft.resume)
      if (!result.ok || !result.fields) {
        showToast('warn', result.error ?? 'Nothing could be extracted.')
        return
      }
      // Fill blanks only — never overwrite something the user typed themselves.
      const filled: string[] = []
      setDraft((d) => {
        const next = { ...d }
        for (const [key, value] of Object.entries(result.fields!)) {
          const k = key as keyof CandidateProfile
          if (!next[k]?.trim() && value?.trim()) {
            next[k] = value
            filled.push(key)
          }
        }
        return next
      })
      setDirty(true)
      showToast(
        filled.length > 0 ? 'info' : 'warn',
        filled.length > 0
          ? `Filled ${filled.length} field${filled.length === 1 ? '' : 's'} — review, then Apply.`
          : 'All fields were already filled in; nothing changed.'
      )
    } finally {
      setAutofilling(false)
    }
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

      <Field
        label="Answer complexity"
        hint="How advanced the vocabulary and depth should sound. Adjustable live with the “simpler / deeper” buttons on any answer."
      >
        <Select<AnswerComplexity>
          value={settings?.session.complexity ?? 'balanced'}
          options={[
            { value: 'simple', label: 'Simple — plain words, no unprompted jargon' },
            { value: 'balanced', label: 'Balanced — working-engineer voice' },
            { value: 'advanced', label: 'Advanced — senior voice, tradeoffs, numbers' },
          ]}
          onChange={(complexity) => {
            if (!settings) return
            void window.cue
              .setSettings({ session: { ...settings.session, complexity } })
              .then(setSettings)
          }}
        />
      </Field>

      <Toggle
        label="Ground answers in my profile"
        hint={
          'Answers only claim experience this page supports. Unfamiliar topics get an honest ' +
          '“I haven’t used it hands-on, but I know the concept…” with a bridge to what you do know. ' +
          'Turn off for unconstrained best-possible answers.' +
          (settings?.session.grounded && !hasSubstance
            ? ' — Add skills, projects or work experience below for this to have any effect.'
            : '')
        }
        checked={settings?.session.grounded ?? true}
        onChange={(grounded) => {
          if (!settings) return
          void window.cue.setSettings({ session: { ...settings.session, grounded } }).then(setSettings)
        }}
      />

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

      <div className="grid grid-cols-2 gap-2">
        <Field label="Company">
          <TextInput value={draft.company} onChange={(v) => update('company', v)} />
        </Field>
        <Field label="Education">
          <TextInput
            value={draft.education}
            onChange={(v) => update('education', v)}
            placeholder="B.Tech CSE, 2024"
          />
        </Field>
      </div>

      <Field label="Skills" hint="Comma-separated. Also used to bias speech recognition — and, when grounding is on, this is the boundary of what answers may claim.">
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

      <Field
        label="Work experience"
        hint="Companies, roles, what you actually did — behavioral answers draw from this."
      >
        <TextArea
          value={draft.workExperience}
          onChange={(v) => update('workExperience', v)}
          rows={3}
          placeholder="Acme — Full-stack dev — built the payments dashboard, led the React migration"
        />
      </Field>

      <Field label="Job description">
        <TextArea value={draft.jobDescription} onChange={(v) => update('jobDescription', v)} rows={4} />
      </Field>

      <Field label="Resume" hint="Pasted text. Trimmed automatically to keep prompts small and fast.">
        <TextArea value={draft.resume} onChange={(v) => update('resume', v)} rows={5} />
      </Field>

      <Button
        onClick={() => void autofill()}
        disabled={!draft.resume.trim() || autofilling}
        title="Extracts skills, projects, education and work history from the pasted resume. Fills empty fields only — your own entries are never overwritten."
      >
        {autofilling ? 'Reading resume…' : 'Auto-fill profile from this resume'}
      </Button>

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
          title="Empties the form. Apply afterwards to also delete the encrypted copy from disk."
        >
          Clear
        </Button>
        <span className="ml-auto text-[10px] text-fg-faint">
          Encrypted on this device · never leaves it
        </span>
      </div>
    </div>
  )
}
