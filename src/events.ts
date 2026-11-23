// The printers' events, each versioned: what changed on a printer, its jobs and their timelapses. A job's
// events carry its id (`<printer id>-<startedAt ms>`), and the problem in Bambu's words where there is one.
import { defineEvent } from "switch-ext-kit"
import { Schema } from "effect"

const who = { printer: Schema.String, name: Schema.String }
const job = { ...who, file: Schema.String, job: Schema.String }
const progress = {
  percent: Schema.Finite,
  layer: Schema.Finite,
  layers: Schema.Finite,
  /** When it'll be done, in ms. */
  endsAt: Schema.NullOr(Schema.Finite),
}
const phase = Schema.Literals([
  "printing",
  "preparing",
  "paused",
  "finished",
  "failed",
  "cancelled",
  "idle",
  "offline",
])

export const StateChanged = defineEvent(
  "printers.state_changed",
  1,
  Schema.Struct({ ...who, from: phase, to: phase }),
)
export const PrinterRenamed = defineEvent(
  "printers.renamed",
  1,
  Schema.Struct({ ...who, from: Schema.String }),
)
export const JobStarted = defineEvent(
  "printers.job_started",
  1,
  Schema.Struct({ ...job, ...progress }),
)
/** A running job's percent moved: what a Live Activity shows. */
export const JobProgress = defineEvent(
  "printers.job_progress",
  1,
  Schema.Struct({ ...job, ...progress, phase }),
)
export const JobFinished = defineEvent(
  "printers.job_finished",
  1,
  Schema.Struct({ ...job, minutes: Schema.NullOr(Schema.Finite) }),
)
export const JobFailed = defineEvent(
  "printers.job_failed",
  1,
  Schema.Struct({
    ...job,
    cancelled: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
    percent: Schema.Finite,
  }),
)
/** Paused on a problem: not by a person (stages 16, 5 and 30). */
export const JobPaused = defineEvent(
  "printers.job_paused",
  1,
  Schema.Struct({
    ...job,
    reason: Schema.optionalKey(Schema.String),
    layer: Schema.Finite,
    layers: Schema.Finite,
  }),
)
/** Its printer gave no report for five minutes mid-job: power or Wi-Fi. */
export const JobLost = defineEvent(
  "printers.job_lost",
  1,
  Schema.Struct({ ...job, minutes: Schema.Finite, layer: Schema.Finite, layers: Schema.Finite }),
)
const recorded = { ...who, file: Schema.String, job: Schema.optionalKey(Schema.String) }
/** A print's timelapse, encoded: the video and its preview (the last frame, small), absolute paths. */
export const TimelapseSaved = defineEvent(
  "printers.timelapse_saved",
  1,
  Schema.Struct({ ...recorded, video: Schema.String, preview: Schema.optionalKey(Schema.String) }),
)
export const TimelapseFailed = defineEvent(
  "printers.timelapse_failed",
  1,
  Schema.Struct({ ...recorded, reason: Schema.String }),
)
export const FilamentRanOut = defineEvent(
  "printers.filament_ran_out",
  1,
  Schema.Struct({ ...job, layer: Schema.Finite }),
)
export const PrinterError = defineEvent(
  "printers.error",
  1,
  Schema.Struct({ ...who, code: Schema.String, text: Schema.optionalKey(Schema.String) }),
)
const slotFacts = Schema.Struct({
  slot: Schema.String,
  type: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(Schema.String),
  brand: Schema.optionalKey(Schema.String),
})
export const SlotsChanged = defineEvent(
  "printers.slots_changed",
  1,
  Schema.Struct({ ...who, slots: Schema.Array(slotFacts) }),
)

export const EVENTS = [
  StateChanged,
  PrinterRenamed,
  JobStarted,
  JobProgress,
  JobFinished,
  JobFailed,
  JobPaused,
  JobLost,
  TimelapseSaved,
  TimelapseFailed,
  FilamentRanOut,
  PrinterError,
  SlotsChanged,
]
