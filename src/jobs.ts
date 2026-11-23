// Each printer's job, kept in the extension's folder: the last one per printer (jobs.json), as the
// Printers app kept its jobs, so a restart mid-print goes on with the job it was following; and every
// job's history (jobs.jsonl), a line appended whenever one starts, changes or ends, the newest line
// for an id winning.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

const FILE = path.resolve("jobs.json")
const HISTORY = path.resolve("jobs.jsonl")

const OUTCOMES = ["finished", "failed", "cancelled", "stopped", "lost", "running"] as const
export type Outcome = (typeof OUTCOMES)[number]

const timelapse = Schema.Struct({
  status: Schema.Literals(["recording", "encoding", "saved", "failed", "none"]),
  video: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
})
export type JobTimelapse = typeof timelapse.Type

const job = Schema.Struct({
  /** `<printer id>-<startedAt ms>`, or when it was first seen when its start wasn't. */
  id: Schema.String,
  printer: Schema.String,
  name: Schema.String,
  file: Schema.String,
  /** Null when it was running before it was first seen. */
  startedAt: Schema.NullOr(Schema.Finite),
  endedAt: Schema.NullOr(Schema.Finite),
  outcome: Schema.Literals(OUTCOMES),
  reason: Schema.optionalKey(Schema.String),
  layer: Schema.Finite,
  layers: Schema.Finite,
  /** print's light: the chamber light kept on through it. */
  keepLight: Schema.Boolean,
  lightAt: Schema.Finite,
  timelapse,
})
export type Job = typeof job.Type

/** jobs.json as it was before jobs had ids and outcomes past an end. */
const before = Schema.Struct({
  file: Schema.String,
  startedAt: Schema.NullOr(Schema.Finite),
  endedAt: Schema.NullOr(Schema.Finite),
  outcome: Schema.NullOr(Schema.Literals(["finished", "failed", "cancelled"])),
})
const kept = Schema.Union([job, before])
const decodeKept = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, kept)),
)
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(job))

const upgrade = (id: string, j: typeof kept.Type): Job =>
  "id" in j
    ? j
    : {
        id: `${id}-${j.startedAt ?? j.endedAt ?? 0}`,
        printer: id,
        name: id,
        file: j.file,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        outcome: j.outcome ?? (j.endedAt === null ? "running" : "stopped"),
        layer: 0,
        layers: 0,
        keepLight: false,
        lightAt: 0,
        timelapse: { status: "none" },
      }

/** What was kept, by printer id: nothing when there's no file or it doesn't read. */
export const loadJobs = (): Map<string, Job> => {
  if (!existsSync(FILE)) {
    return new Map()
  }
  const read = decodeKept(readFileSync(FILE, "utf-8"))
  return new Map(
    read._tag === "Some"
      ? Object.entries(read.value).map(([id, j]) => [id, upgrade(id, j)] as const)
      : [],
  )
}

export const saveJobs = (jobs: ReadonlyMap<string, Job>) => {
  const tmp = `${FILE}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(jobs)))
    renameSync(tmp, FILE)
  } catch {
    // A job not kept is only lost to a restart; the printer goes on being followed.
  }
}

/** A job as it stands now, appended to the history. */
export const record = (j: Job) => {
  try {
    appendFileSync(HISTORY, `${JSON.stringify(j)}\n`)
  } catch {
    // A line not written leaves the job's last line standing.
  }
}

/** Every job, its newest line, newest first. */
export const history = (): Job[] => {
  if (!existsSync(HISTORY)) {
    return []
  }
  const byId = new Map<string, Job>()
  for (const line of readFileSync(HISTORY, "utf-8").split("\n")) {
    const j = decodeLine(line)
    if (j._tag === "Some") {
      byId.delete(j.value.id)
      byId.set(j.value.id, j.value)
    }
  }
  return [...byId.values()].toSorted((a, b) => begun(b) - begun(a))
}

/** When a job began, or was first seen: its id's last part. */
const begun = (j: Job) => Number(j.id.slice(j.id.lastIndexOf("-") + 1)) || 0
