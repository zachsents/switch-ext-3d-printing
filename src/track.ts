// What changed on a printer between two reports, as events: its state, a job starting, moving,
// pausing on a problem, going quiet, finishing or failing, filament running out, a new error, its
// slots. And the printer's job as it changes, for jobs.json and the history. Pure, given the time,
// when the printer last reported and the job it kept.
import type { Draft } from "switch-ext-kit"

import {
  FilamentRanOut,
  JobFailed,
  JobFinished,
  JobLost,
  JobPaused,
  JobProgress,
  JobStarted,
  PrinterError,
  SlotsChanged,
  StateChanged,
} from "./events.ts"
import type { Job } from "./jobs.ts"
import { CANCELED, isActive, RUN_OUT_STAGE } from "./state.ts"
import type { View } from "./state.ts"

/** A printer offline this long counts as gone; shorter drops are reconnects. */
const GONE_MS = 30_000
/** A job's printer silent this long is lost (power or Wi-Fi). */
export const LOST_MS = 5 * 60_000
/** Stages a person pauses on (the screen, a pause in the G-code). */
const PAUSED_BY_A_PERSON = new Set([16, 5, 30])

/** What's kept per printer to tell what changed. */
export interface Seen {
  readonly phase: View["phase"]
  readonly state: string
  readonly file: string
  readonly percent: number
  readonly layer: number
  readonly layers: number
  readonly stage: number | undefined
  readonly errors: ReadonlySet<string>
  readonly slots: string
  readonly startedAt: number | null
  readonly offlineSince: number | null
}

export interface Tracked {
  readonly seen: Seen | undefined
  readonly drafts: readonly Draft[]
  /** One activity slot per printer, stable across observer restarts. */
  readonly activity?: { readonly kind: "start" | "update" | "end"; readonly key: string }
  /** The printer's jobs that changed, in order: one replaced, then its successor. */
  readonly jobs: readonly Job[]
}

/** Each AMS slot, then the external spool ("ext") when it's set: what each holds. */
export const shownSlots = (v: View) => [
  ...v.slots.map((s) => ({
    slot: s.slot,
    ...(s.type === undefined ? {} : { type: s.type }),
    ...(s.color === undefined ? {} : { color: s.color }),
    ...(s.brand === undefined ? {} : { brand: s.brand }),
  })),
  ...(v.spool ? [{ slot: "ext", ...v.spool }] : []),
]

const progressOf = (v: View) => ({
  percent: v.percent,
  layer: v.layer,
  layers: v.layers,
  endsAt: v.endsAt,
})

/** A duration: "40 s", "12 min", "1 h 5 min". */
const duration = (ms: number) => {
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${Math.max(0, Math.round(seconds))} s`
  }
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

/** A job begun now (or first seen now, when `startedAt` is null). */
const begin = (v: View, file: string, startedAt: number | null, now: number): Job => ({
  id: `${v.id}-${startedAt ?? now}`,
  printer: v.id,
  name: v.name,
  file,
  startedAt,
  endedAt: null,
  outcome: "running",
  layer: v.layer,
  layers: v.layers,
  keepLight: false,
  lightAt: 0,
  timelapse: { status: "none" },
})

const open = (j: Job | undefined, file: string) =>
  j?.endedAt === null && j.file === file ? j : undefined

/** Its errors in words, the cancel aside. */
const problems = (v: View) =>
  v.errors
    .filter((x) => x.code !== CANCELED)
    .map((x) => x.text ?? x.code)
    .join("; ")

/**
 * A job's end: its event, and the job as it ended, as a job tracker before told it: finished, cancelled,
 * failed, else stopped (the printer went idle), with its problems as the reason.
 */
const ended = (v: View, job: Job, now: number) => {
  const w = { printer: v.id, name: v.name, file: job.file, job: job.id }
  const minutes = job.startedAt === null ? null : Math.round((now - job.startedAt) / 60_000)
  const last = { ...job, name: v.name, endedAt: now, layer: v.layer || job.layer }
  if (v.state === "FINISH") {
    const { reason: _, ...rest } = last
    return {
      draft: JobFinished.make({ ...w, minutes }),
      job: { ...rest, outcome: "finished" as const },
    }
  }
  const reason = problems(v)
  const cancelled = v.errors.some((x) => x.code === CANCELED)
  let outcome: Job["outcome"] = v.state === "FAILED" ? "failed" : "stopped"
  if (cancelled) {
    outcome = "cancelled"
  }
  const draft = JobFailed.make({
    ...w,
    cancelled,
    percent: v.percent,
    ...(reason === "" ? {} : { reason }),
  })
  const { reason: _, ...rest } = last
  return {
    draft,
    job: { ...rest, outcome, ...(reason === "" || cancelled ? {} : { reason }) } satisfies Job,
  }
}

/** A job started on the printer, ending one it replaced before its end was seen. */
const started = (v: View, file: string, now: number, kept?: Job) => {
  const jobs: Job[] = []
  if (kept) {
    const { reason: _, ...rest } = kept
    jobs.push({
      ...rest,
      endedAt: now,
      outcome: "stopped",
      reason: "replaced by another print before its end was seen",
    })
  }
  const job = begin(v, file, now, now)
  jobs.push(job)
  return {
    drafts: [JobStarted.make({ printer: v.id, name: v.name, file, job: job.id, ...progressOf(v) })],
    jobs,
  }
}

/** A running job moved, paused (told when it's a problem) or went on. */
const running = (before: Seen, v: View, stage: number | undefined, job: Job) => {
  const drafts: Draft[] = []
  const jobs: Job[] = []
  const w = { printer: v.id, name: v.name, file: job.file, job: job.id }
  const moved = v.percent !== before.percent || v.phase !== before.phase
  if (moved) {
    drafts.push(JobProgress.make({ ...w, ...progressOf(v), phase: v.phase }))
  }
  const { reason: _, ...step } = { ...job, name: v.name, layer: v.layer, layers: v.layers }
  if (v.state === "PAUSE" && before.state !== "PAUSE") {
    const reason = [v.stage, problems(v)].filter(Boolean).join(", ")
    const why = reason === "" ? {} : { reason }
    jobs.push({ ...step, ...why })
    if (stage === undefined || !PAUSED_BY_A_PERSON.has(stage)) {
      drafts.push(JobPaused.make({ ...w, ...why, layer: v.layer, layers: v.layers }))
    }
  } else if ((v.state !== "PAUSE" && before.state === "PAUSE") || job.outcome === "lost") {
    jobs.push({ ...step, outcome: "running" })
  }
  return { drafts, jobs, moved }
}

/** The job's events: started, moved, paused on a problem, back, ended; its activity and changes. */
const jobOf = (before: Seen, v: View, stage: number | undefined, now: number, kept?: Job) => {
  const file = v.file ?? before.file
  const was = isActive(before.state)
  const is = isActive(v.state)
  const current = open(kept, before.file)
  if (is && (!was || file !== before.file)) {
    const start = started(v, file, now, current)
    return { ...start, file, startedAt: now, activity: { kind: "start" as const, key: v.id } }
  }
  if (is) {
    const fresh = current ? [] : [begin(v, file, null, now)]
    const job = current ?? begin(v, file, null, now)
    const run = running(before, v, stage, job)
    return {
      drafts: run.drafts,
      jobs: [...fresh, ...run.jobs],
      file,
      startedAt: before.startedAt,
      ...(run.moved ? { activity: { kind: "update" as const, key: v.id } } : {}),
    }
  }
  if (was && current) {
    const end = ended(v, current, now)
    return {
      drafts: [end.draft],
      jobs: [end.job],
      file,
      startedAt: null,
      activity: { kind: "end" as const, key: v.id },
    }
  }
  return { drafts: [], jobs: [], file, startedAt: was ? null : before.startedAt }
}

/** Filament running out, new errors, the slots changing. */
const alertsOf = (before: Seen, v: View, stage: number | undefined, slots: string, job: string) => {
  const drafts: Draft[] = []
  const w = { printer: v.id, name: v.name }
  if (isActive(v.state) && stage === RUN_OUT_STAGE && before.stage !== RUN_OUT_STAGE) {
    drafts.push(FilamentRanOut.make({ ...w, file: v.file ?? before.file, job, layer: v.layer }))
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
  const shown = shownSlots(v)
  if (slots !== before.slots && shown.length > 0) {
    drafts.push(SlotsChanged.make({ ...w, slots: shown }))
  }
  return drafts
}

/**
 * The first report is where it stands. A job it kept that's still the printer's plate goes on, or,
 * when the printer isn't printing now, ends: finished or failed as the printer says, else stopped, as
 * an earlier tracker ended a print on its first look only when the job it kept was still
 * running. Nothing else is told: an idle
 * printer's last print, ended before or never kept, isn't ended again. A job running that it didn't
 * keep is followed from here, its start unknown.
 */
const first = (v: View, seen: Seen, kept: Job | undefined, now: number): Tracked => {
  const job = open(kept, seen.file)
  if (isActive(v.state)) {
    const activity = { kind: "start" as const, key: v.id }
    if (job) {
      return { seen: { ...seen, startedAt: job.startedAt }, drafts: [], activity, jobs: [] }
    }
    const replaced: Job[] =
      kept?.endedAt === null
        ? [
            {
              ...kept,
              endedAt: now,
              outcome: "stopped",
              reason: "replaced by another print before its end was seen",
            },
          ]
        : []
    return { seen, drafts: [], activity, jobs: [...replaced, begin(v, seen.file, null, now)] }
  }
  if (job && (v.state === "FINISH" || v.state === "FAILED")) {
    const end = ended(v, job, now)
    return { seen, drafts: [end.draft], activity: { kind: "end", key: v.id }, jobs: [end.job] }
  }
  if (job) {
    return {
      seen,
      drafts: [],
      activity: { kind: "end", key: v.id },
      jobs: [{ ...job, endedAt: now, outcome: "stopped" }],
    }
  }
  return { seen, drafts: [], jobs: [] }
}

/** A printer silent mid-job: once LOST_MS have passed since its last report, the job is lost. */
const lost = (before: Seen, v: View, now: number, heardAt: number, kept?: Job) => {
  const job = open(kept, before.file)
  if (!job || job.outcome === "lost" || !isActive(before.state) || now - heardAt < LOST_MS) {
    return { drafts: [], jobs: [] }
  }
  const quiet = now - heardAt
  return {
    drafts: [
      JobLost.make({
        printer: v.id,
        name: v.name,
        file: job.file,
        job: job.id,
        minutes: Math.round(quiet / 60_000),
        layer: before.layer,
        layers: before.layers,
      }),
    ],
    jobs: [{ ...job, outcome: "lost" as const, reason: `no word from it for ${duration(quiet)}` }],
  }
}

export const track = (
  before: Seen | undefined,
  v: View,
  stage: number | undefined,
  now: number,
  kept: Job | undefined,
  heardAt: number,
): Tracked => {
  const slots = JSON.stringify(shownSlots(v))
  const errors = new Set(v.errors.map((x) => x.code))
  if (!before) {
    if (!v.online) {
      return { seen: undefined, drafts: [], jobs: [] }
    }
    const seen: Seen = {
      phase: v.phase,
      state: v.state,
      file: v.file ?? "",
      percent: v.percent,
      layer: v.layer,
      layers: v.layers,
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
    const quiet = lost(before, v, now, heardAt, kept)
    return {
      seen: { ...before, offlineSince: since, ...(gone ? { phase: "offline" as const } : {}) },
      drafts: [
        ...(gone
          ? [StateChanged.make({ printer: v.id, name: v.name, from: before.phase, to: "offline" })]
          : []),
        ...quiet.drafts,
      ],
      jobs: quiet.jobs,
    }
  }
  const changed =
    v.phase === before.phase
      ? []
      : [StateChanged.make({ printer: v.id, name: v.name, from: before.phase, to: v.phase })]
  const job = jobOf(before, v, stage, now, kept)
  const seen: Seen = {
    phase: v.phase,
    state: v.state,
    file: job.file,
    percent: v.percent,
    layer: v.layer,
    layers: v.layers,
    stage,
    errors,
    slots,
    startedAt: job.startedAt,
    offlineSince: null,
  }
  const current = job.jobs.at(-1) ?? open(kept, job.file)
  return {
    seen,
    drafts: [...changed, ...job.drafts, ...alertsOf(before, v, stage, slots, current?.id ?? "")],
    ...("activity" in job ? { activity: job.activity } : {}),
    jobs: job.jobs,
  }
}
