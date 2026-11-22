// What changed on a printer between two reports, as events: its state, a job starting, moving,
// finishing or failing, filament running out, a new error, its slots. Pure, given the time and the
// job it kept from before a restart.
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

/**
 * A printer's last job, kept across restarts (jobs.ts) as the Printers app kept it: its plate, when
 * it started (null when it was running before this observer first saw it), and how and when it
 * ended. A restart mid-print goes on with it, so its duration and its "Done 3:44 PM" hold.
 */
export interface Job {
  readonly file: string
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly outcome: "finished" | "failed" | "cancelled" | null
}

export interface Tracked {
  readonly seen: Seen | undefined
  readonly drafts: readonly Draft[]
  /** One activity slot per printer, stable across observer restarts. */
  readonly activity?: { readonly kind: "start" | "update" | "end"; readonly key: string }
  /** The printer's job, when it started or ended. */
  readonly job?: Job
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

/** A job's end: its event, and the job as it ended. */
const ended = (v: View, file: string, startedAt: number | null, now: number) => {
  const w = { printer: v.id, name: v.name, file }
  if (v.state === "FINISH") {
    const minutes = startedAt === null ? null : Math.round((now - startedAt) / 60_000)
    const job: Job = { file, startedAt, endedAt: now, outcome: "finished" }
    return { draft: JobFinished.make({ ...w, minutes }), job }
  }
  const reason = v.errors
    .filter((x) => x.code !== CANCELED)
    .map((x) => x.text ?? x.code)
    .join("; ")
  const cancelled = v.errors.some((x) => x.code === CANCELED)
  const job: Job = { file, startedAt, endedAt: now, outcome: cancelled ? "cancelled" : "failed" }
  const draft = JobFailed.make({
    ...w,
    cancelled,
    percent: v.percent,
    ...(reason === "" ? {} : { reason }),
  })
  return { draft, job }
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
  let job: Job | undefined
  if (is && (!was || file !== before.file)) {
    startedAt = now
    job = { file, startedAt, endedAt: null, outcome: null }
    drafts.push(JobStarted.make({ ...w, ...progressOf(v) }))
    activity = { kind: "start", key: v.id }
  } else if (is && (v.percent !== before.percent || v.phase !== before.phase)) {
    drafts.push(JobProgress.make({ ...w, ...progressOf(v), phase: v.phase }))
    activity = { kind: "update", key: v.id }
  }
  if (was && !is) {
    const { draft, job: last } = ended(v, file, startedAt, now)
    drafts.push(draft)
    job = last
    activity = { kind: "end", key: v.id }
    startedAt = null
  }
  return { drafts, file, startedAt, activity, job }
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

/**
 * The first report is where it stands. A job it kept that's still the printer's plate goes on, or,
 * when the printer says it finished or failed meanwhile, ends now. Nothing else is told.
 */
const first = (v: View, seen: Seen, kept: Job | undefined, now: number): Tracked => {
  const activity = { kind: isActive(v.state) ? ("start" as const) : ("end" as const), key: v.id }
  const open = kept?.endedAt === null && kept.file === seen.file ? kept : undefined
  if (open && isActive(v.state)) {
    return { seen: { ...seen, startedAt: open.startedAt }, drafts: [], activity }
  }
  if (open && (v.state === "FINISH" || v.state === "FAILED")) {
    const { draft, job } = ended(v, open.file, open.startedAt, now)
    return { seen, drafts: [draft], activity, job }
  }
  return { seen, drafts: [], activity }
}

export const track = (
  before: Seen | undefined,
  v: View,
  stage: number | undefined,
  now: number,
  kept?: Job,
): Tracked => {
  const slots = JSON.stringify(shownSlots(v))
  const errors = new Set(v.errors.map((x) => x.code))
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
      // A job running unseen began before this observer connected.
      startedAt: null,
      offlineSince: null,
    }
    return first(v, seen, kept, now)
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
    ...(job.job === undefined ? {} : { job: job.job }),
  }
}
