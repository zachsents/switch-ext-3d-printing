// What changed on a printer between two reports, as events: its state, a job starting, moving,
// finishing or failing, filament running out, a new error, its slots. Pure, given the time.
import type { Draft } from "switch-ext-kit"

import {
  FilamentRanOut,
  JobFailed,
  JobFinished,
  JobProgress,
  JobStarted,
  PrinterError,
  SlotsChanged,
  StateChanged,
} from "./events.ts"
import { CANCELED, isActive, RUN_OUT_STAGE } from "./state.ts"
import type { View } from "./state.ts"

/** A printer offline this long counts as gone; shorter drops are reconnects. */
const GONE_MS = 30_000

/** What's kept per printer to tell what changed. */
export interface Seen {
  readonly phase: View["phase"]
  readonly state: string
  readonly file: string
  readonly percent: number
  readonly stage: number | undefined
  readonly errors: ReadonlySet<string>
  readonly slots: string
  readonly startedAt: number | null
  readonly offlineSince: number | null
}

export interface Tracked {
  readonly seen: Seen | undefined
  readonly drafts: readonly Draft[]
  /** The print's Live Activity: started, moved or ended, by one key per print. */
  readonly activity?: { readonly kind: "start" | "update" | "end"; readonly key: string }
}

export const shownSlots = (v: View) =>
  v.slots.map((s) => ({
    slot: s.slot,
    ...(s.type === undefined ? {} : { type: s.type }),
    ...(s.color === undefined ? {} : { color: s.color }),
    ...(s.brand === undefined ? {} : { brand: s.brand }),
  }))

const progressOf = (v: View) => ({
  percent: v.percent,
  layer: v.layer,
  layers: v.layers,
  endsAt: v.endsAt,
})

const ended = (v: View, file: string, startedAt: number | null, now: number): Draft => {
  const w = { printer: v.id, name: v.name, file }
  if (v.state === "FINISH") {
    const minutes = startedAt === null ? null : Math.round((now - startedAt) / 60_000)
    return JobFinished.make({ ...w, minutes })
  }
  const reason = v.errors
    .filter((x) => x.code !== CANCELED)
    .map((x) => x.text ?? x.code)
    .join("; ")
  return JobFailed.make({
    ...w,
    cancelled: v.errors.some((x) => x.code === CANCELED),
    percent: v.percent,
    ...(reason === "" ? {} : { reason }),
  })
}

/** The job's events: started, moved, ended; and its activity. */
const jobOf = (before: Seen, v: View, now: number) => {
  const drafts: Draft[] = []
  const file = v.file ?? before.file
  const w = { printer: v.id, name: v.name, file }
  const was = isActive(before.state)
  const is = isActive(v.state)
  let { startedAt } = before
  let activity: Tracked["activity"]
  if (is && (!was || file !== before.file)) {
    startedAt = now
    drafts.push(JobStarted.make({ ...w, ...progressOf(v) }))
    activity = { kind: "start", key: `${v.id}:${now}` }
  } else if (is && (v.percent !== before.percent || v.phase !== before.phase)) {
    drafts.push(JobProgress.make({ ...w, ...progressOf(v), phase: v.phase }))
    activity = { kind: "update", key: `${v.id}:${startedAt ?? 0}` }
  }
  if (was && !is) {
    drafts.push(ended(v, file, startedAt, now))
    activity = { kind: "end", key: `${v.id}:${startedAt ?? 0}` }
    startedAt = null
  }
  return { drafts, file, startedAt, activity }
}

/** Filament running out, new errors, the slots changing. */
const alertsOf = (before: Seen, v: View, stage: number | undefined, slots: string) => {
  const drafts: Draft[] = []
  const w = { printer: v.id, name: v.name }
  if (isActive(v.state) && stage === RUN_OUT_STAGE && before.stage !== RUN_OUT_STAGE) {
    drafts.push(FilamentRanOut.make({ ...w, file: v.file ?? before.file, layer: v.layer }))
  }
  for (const x of v.errors) {
    if (!before.errors.has(x.code) && x.code !== CANCELED) {
      drafts.push(
        PrinterError.make({
          ...w,
          code: x.code,
          ...(x.text === undefined ? {} : { text: x.text }),
        }),
      )
    }
  }
  if (slots !== before.slots && v.slots.length > 0) {
    drafts.push(SlotsChanged.make({ ...w, slots: shownSlots(v) }))
  }
  return drafts
}

export const track = (
  before: Seen | undefined,
  v: View,
  stage: number | undefined,
  now: number,
): Tracked => {
  const slots = JSON.stringify(shownSlots(v))
  const errors = new Set(v.errors.map((x) => x.code))
  // The first report is where it stands: nothing to tell.
  if (!before) {
    if (!v.online) {
      return { seen: undefined, drafts: [] }
    }
    const seen: Seen = {
      phase: v.phase,
      state: v.state,
      file: v.file ?? "",
      percent: v.percent,
      stage,
      errors,
      slots,
      // An already running job began before this observer connected.
      startedAt: null,
      offlineSince: null,
    }
    return { seen, drafts: [] }
  }
  // A drop shorter than GONE_MS is a reconnect; the next session's report picks up from here.
  if (!v.online) {
    const since = before.offlineSince ?? now
    const gone = now - since >= GONE_MS && before.phase !== "offline"
    return {
      seen: { ...before, offlineSince: since, ...(gone ? { phase: "offline" as const } : {}) },
      drafts: gone
        ? [StateChanged.make({ printer: v.id, name: v.name, from: before.phase, to: "offline" })]
        : [],
    }
  }
  const changed =
    v.phase === before.phase
      ? []
      : [StateChanged.make({ printer: v.id, name: v.name, from: before.phase, to: v.phase })]
  const job = jobOf(before, v, now)
  const seen: Seen = {
    phase: v.phase,
    state: v.state,
    file: job.file,
    percent: v.percent,
    stage,
    errors,
    slots,
    startedAt: job.startedAt,
    offlineSince: null,
  }
  return {
    seen,
    drafts: [...changed, ...job.drafts, ...alertsOf(before, v, stage, slots)],
    ...(job.activity === undefined ? {} : { activity: job.activity }),
  }
}
