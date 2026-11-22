// Each printer's last job, kept in the extension's folder (jobs.json) as the Printers app kept its
// jobs, so a restart mid-print goes on with the job it was following.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

import type { Job } from "./track.ts"

const FILE = path.resolve("jobs.json")

const job = Schema.Struct({
  file: Schema.String,
  startedAt: Schema.NullOr(Schema.Finite),
  endedAt: Schema.NullOr(Schema.Finite),
  outcome: Schema.NullOr(Schema.Literals(["finished", "failed", "cancelled"])),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, job)))

/** What was kept, by printer id: nothing when there's no file or it doesn't read. */
export const loadJobs = (): Map<string, Job> => {
  if (!existsSync(FILE)) {
    return new Map()
  }
  const kept = decode(readFileSync(FILE, "utf-8"))
  return new Map<string, Job>(kept._tag === "Some" ? Object.entries(kept.value) : [])
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
