// Every print's camera timelapse, recorded in this process from the extension's own camera, as the
// `bambu` CLI's recorder made it (record, capture, snap_until_done, Frames): frames into
// <root>/<stem>.frames/ while the job runs (every `interval` s, 4x that while paused), five frames
// of the finished part, then the library encodes <stem>.mp4 and a small <stem>.jpg and deletes the
// frames. A recording is kept in the extension's folder (timelapses.json), so after a restart it
// goes on into the same frames folder, and a printer that goes quiet mid-print is waited for rather
// than given up on.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import type { Draft } from "switch-ext-kit"
import type { Camera } from "./camera.ts"
import { TimelapseFailed, TimelapseSaved } from "./events.ts"
import type { JobTimelapse } from "./jobs.ts"
import { library } from "./lib.ts"
import { framesOf, freeBytes, log, nearest, Shots } from "./shots.ts"
import { isActive } from "./state.ts"
import type { Raw } from "./state.ts"

/** Free bytes under which it snaps at least every 60 s (the CLI's LOW_DISK). */
const LOW_DISK = 2e9
/** How long a sent job may take to start before the recording gives up (the CLI's START_GRACE). */
const START_GRACE_MS = 600_000
/** The finished part: this many frames, this far apart. */
const END_FRAMES = 5
const END_EVERY_MS = 3000
/** Seconds between frames unless asked otherwise, and the least (a grab took about one). */
export const INTERVAL_S = 15
export const MIN_INTERVAL_S = 2
const ENCODE_MS = 30 * 60_000

const STATE = path.resolve("timelapses.json")

const expand = (p: string) => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p)

/** PRINTERS_TIMELAPSES: candidate folders, the first on a mounted, writable volume winning. */
const CANDIDATES = (process.env.PRINTERS_TIMELAPSES ?? "")
  .split(":")
  .map((p) => p.trim())
  .filter((p) => p !== "")
  .map(expand)
const FALLBACK = CANDIDATES.at(-1) ?? path.resolve("timelapses")

const writable = (p: string) => {
  try {
    accessSync(p, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a folder's volume is there to write to. A folder on an external volume counts only while
 * that volume is mounted and writable: an unplugged drive can leave a plain folder at its mount
 * point, on the internal disk (the CLI's timelapse_root checked the mount, not the folder).
 */
const usable = (folder: string) => {
  const parts = folder.split(path.sep)
  if (parts[1] === "Volumes" && parts[2] !== undefined) {
    const volume = path.join("/Volumes", parts[2])
    return (
      existsSync(volume) && statSync(volume).dev !== statSync("/Volumes").dev && writable(volume)
    )
  }
  return writable(nearest(folder))
}

/** Where new recordings go now. */
export const timelapseRoot = () => CANDIDATES.slice(0, -1).find(usable) ?? FALLBACK

/** Seconds between frames: as asked, but at least 60 s (and 4x as asked) under 2 GB free. */
const snapInterval = (requested: number, free: number) =>
  free < LOW_DISK ? Math.max(requested * 4, 60) : requested

const two = (n: number) => String(n).padStart(2, "0")

/** A plate's name without its .gcode.3mf, as the printer names its job. */
export const plateStem = (source: string) =>
  path.basename(source).replace(/(?:\.gcode)?\.3mf$|\.gcode$/iu, "")

/** 'YYYY-MM-DD_HHMM_<printer>_<file stem>' in local time, the stem made safe for a file name. */
const timelapseStem = (printer: string, source: string, when: number) => {
  const d = new Date(when)
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
  const safe =
    plateStem(source)
      .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
      .replaceAll(/^[-.]+|[-.]+$/gu, "") || "print"
  return `${day}_${two(d.getHours())}${two(d.getMinutes())}_${printer}_${safe}`
}

/** `stem`, or stem-2, stem-3... when a video or frames folder by that name is already in `root`. */
const uniqueStem = (root: string, stem: string) => {
  const taken = (s: string) =>
    existsSync(path.join(root, `${s}.mp4`)) || existsSync(path.join(root, `${s}.frames`))
  let s = stem
  for (let i = 2; taken(s); i += 1) {
    s = `${stem}-${i}`
  }
  return s
}

const recording = Schema.Struct({
  printer: Schema.String,
  source: Schema.String,
  frames: Schema.String,
  out: Schema.String,
  interval: Schema.Finite,
  started: Schema.Finite,
  job: Schema.optionalKey(Schema.String),
})
export type Recording = typeof recording.Type
const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, recording)),
)

/** What a recorder needs of the rest of the extension. */
export interface Host {
  /** The printer's merged reports while it's online, else undefined. */
  readonly raw: (id: string) => Raw | undefined
  readonly camera: (id: string) => Camera
  readonly name: (id: string) => string
  /** The printer's job now, if one is open. */
  readonly job: (id: string) => string | undefined
  /** A job's timelapse changed. */
  readonly timelapse: (printer: string, job: string, tl: JobTimelapse) => void
  readonly emit: (draft: Draft) => void
}

interface Live {
  rec: Recording
  readonly stop: AbortController
  done: Promise<void>
}

const sleep = async (ms: number, signal: AbortSignal) => {
  if (ms <= 0 || signal.aborted) {
    return
  }
  const { promise, resolve } = Promise.withResolvers<undefined>()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => {
    clearTimeout(timer)
    resolve(undefined)
  })
  await promise
}

export class Recorders {
  private readonly live = new Map<string, Live>()
  /** Frames folders being encoded now. */
  private readonly encoding = new Set<string>()
  private awake: ChildProcess | undefined
  private readonly host: Host

  constructor(host: Host) {
    this.host = host
  }

  /** Carries on the recordings kept before a restart whose frames are there and not yet a video. */
  resume() {
    if (!existsSync(STATE)) {
      return
    }
    const kept = decodeState(readFileSync(STATE, "utf-8"))
    for (const rec of kept._tag === "Some" ? Object.values(kept.value) : []) {
      if (existsSync(rec.frames) && !existsSync(rec.out)) {
        log(rec.printer, `carrying on into ${rec.out} from frame ${framesOf(rec.frames).length}`)
        this.run(rec)
      }
    }
    this.save()
  }

  /** Starts a recording of the printer's job, stopping (and encoding) one already running. */
  async start(id: string, source: string, interval: number) {
    const old = await this.stop(id)
    if (old) {
      log(id, `stopped the previous recording; encoding what it had`)
    }
    const root = timelapseRoot()
    mkdirSync(root, { recursive: true })
    const every = snapInterval(interval, freeBytes(root))
    const stem = uniqueStem(root, timelapseStem(id, source, Date.now()))
    const rec: Recording = {
      printer: id,
      source,
      frames: path.join(root, `${stem}.frames`),
      out: path.join(root, `${stem}.mp4`),
      interval: every,
      started: Date.now(),
    }
    mkdirSync(rec.frames, { recursive: true })
    log(id, `one frame every ${every} s, for ${source} -> ${rec.out}`)
    this.run(rec)
    this.save()
    return { ...rec, ...(every === interval ? {} : { note: `under 2 GB free on ${root}` }) }
  }

  /** Stops the printer's recording now; it still encodes what it has. Its recording, if one ran. */
  async stop(id: string) {
    const l = this.live.get(id)
    if (l) {
      l.stop.abort()
      await l.done
    }
    return l?.rec
  }

  /** The running recording's newest frame. */
  latest(id: string) {
    const l = this.live.get(id)
    if (!l) {
      throw new Error(`${this.host.name(id)} has no timelapse recording; camera shows it now`)
    }
    const newest = framesOf(l.rec.frames).at(-1)
    if (newest === undefined) {
      throw new Error(
        `${this.host.name(id)}'s recording has no frame yet (the job hasn't started); camera shows it now`,
      )
    }
    const file = path.join(l.rec.frames, newest)
    return {
      printer: id,
      frame: file,
      age: Math.round((Date.now() - statSync(file).mtimeMs) / 1000),
    }
  }

  /** Recordings running now, frames folders not yet a video, and each folder's newest videos. */
  list() {
    const running = [...this.live.values()].map(({ rec }) => {
      const shots = framesOf(rec.frames)
      const newest = shots.at(-1)
      return {
        printer: rec.printer,
        interval: rec.interval,
        frames: shots.length,
        newest:
          newest === undefined
            ? null
            : Math.round((Date.now() - statSync(path.join(rec.frames, newest)).mtimeMs) / 1000),
        folder: rec.frames,
        out: rec.out,
        ...(rec.job === undefined ? {} : { job: rec.job }),
      }
    })
    const busy = new Set([...this.live.values()].map(({ rec }) => rec.frames))
    const roots = [...new Set([timelapseRoot(), FALLBACK])].filter((r) => existsSync(r))
    const unfinished = roots.flatMap((root) =>
      readdirSync(root)
        .filter((f) => f.endsWith(".frames") && !f.startsWith("."))
        .map((f) => path.join(root, f))
        .filter((f) => !busy.has(f))
        .map((folder) => ({
          folder,
          frames: framesOf(folder).length,
          encoding: this.encoding.has(folder),
        })),
    )
    const folders = roots.map((root) => {
      const videos = readdirSync(root)
        .filter((f) => /\.(?:mp4|avi)$/u.test(f) && !f.endsWith(".part.mp4") && !f.startsWith("."))
        .map((f) => {
          const file = path.join(root, f)
          const st = statSync(file)
          const preview = file.replace(/\.(?:mp4|avi)$/u, ".jpg")
          return {
            name: f,
            video: file,
            ...(existsSync(preview) ? { preview } : {}),
            mb: Math.round(st.size / 1e5) / 10,
            at: st.mtimeMs,
          }
        })
        .toSorted((a, b) => b.at - a.at)
      return { folder: root, videos: videos.length, newest: videos.slice(0, 10) }
    })
    return { recording: running, unfinished, folders }
  }

  /** A frames folder whose recording ended without a video, into one beside it. */
  async encode(folder: string) {
    const frames = path.resolve(expand(folder))
    if ([...this.live.values()].some(({ rec }) => rec.frames === frames)) {
      throw new Error(`${frames} is still recording`)
    }
    if (this.encoding.has(frames)) {
      throw new Error(`${frames} is encoding now`)
    }
    const out = `${frames.replace(/\.frames$/u, "")}.mp4`
    const said = await this.encodeFrames(frames, out)
    return { video: out, said }
  }

  private async encodeFrames(frames: string, out: string) {
    this.encoding.add(frames)
    try {
      return await library(["encode", frames, "--out", out], ENCODE_MS)
    } finally {
      this.encoding.delete(frames)
    }
  }

  private save() {
    const all = Object.fromEntries([...this.live].map(([id, l]) => [id, l.rec]))
    try {
      writeFileSync(`${STATE}.tmp`, JSON.stringify(all))
      renameSync(`${STATE}.tmp`, STATE)
    } catch (error) {
      log("all", `couldn't keep the recordings: ${String(error)}`)
    }
  }

  /** No idle sleep while anything records (the CLI's caffeinate -i -w). */
  private stayAwake() {
    if (this.live.size > 0 && !this.awake) {
      this.awake = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
      this.awake.on("error", () => {
        this.awake = undefined
      })
    } else if (this.live.size === 0 && this.awake) {
      this.awake.kill()
      this.awake = undefined
    }
  }

  private run(rec: Recording) {
    const stop = new AbortController()
    const live: Live = { rec, stop, done: Promise.resolve() }
    this.live.set(rec.printer, live)
    this.stayAwake()
    live.done = (async () => {
      try {
        await this.record(live)
      } catch (error) {
        log(rec.printer, `recorder error: ${String(error)}`)
      }
    })()
  }

  private tell(rec: Recording, tl: JobTimelapse) {
    if (rec.job !== undefined) {
      this.host.timelapse(rec.printer, rec.job, tl)
    }
  }

  /** A recording, start to finish: snapping, the finished part, then the video. */
  private async record(live: Live) {
    const { rec } = live
    const id = rec.printer
    const camera = this.host.camera(id)
    const seen = await this.capture(live, camera)
    this.live.delete(id)
    this.save()
    this.stayAwake()
    const w = {
      printer: id,
      name: this.host.name(id),
      file: rec.source,
      ...(live.rec.job === undefined ? {} : { job: live.rec.job }),
    }
    if (framesOf(rec.frames).length === 0) {
      log(id, `no frames in ${path.basename(rec.frames)}; nothing to encode`)
      rmSync(rec.frames, { recursive: true, force: true })
      if (seen) {
        const reason = "no frames"
        this.tell(live.rec, { status: "failed", reason })
        this.host.emit(TimelapseFailed.make({ ...w, reason }))
      }
      return
    }
    this.tell(live.rec, { status: "encoding" })
    try {
      await this.encodeFrames(rec.frames, rec.out)
      const preview = rec.out.replace(/\.mp4$/u, ".jpg")
      const shown = existsSync(preview) ? { preview } : {}
      this.tell(live.rec, { status: "saved", video: rec.out, ...shown })
      this.host.emit(TimelapseSaved.make({ ...w, video: rec.out, ...shown }))
    } catch (error) {
      const reason =
        (error instanceof Error ? error.message : String(error)).split("\n").at(-1) ?? ""
      this.tell(live.rec, { status: "failed", reason })
      this.host.emit(TimelapseFailed.make({ ...w, reason }))
    }
  }

  /**
   * The snapping: waits up to START_GRACE_MS for the job to start, snaps while it runs, then the
   * finished part. A recording carried on (its folder has frames) has seen the job already, so a job
   * that ended meanwhile ends it at once. Stopped, it ends without the finished part. Whether it saw
   * the job run.
   */
  private async capture(live: Live, camera: Camera) {
    const shots = new Shots(live.rec.frames, camera, live.rec.printer)
    camera.hold()
    try {
      const seen = await this.snapping(live, shots, Date.now(), shots.n > 0)
      if (seen && !live.stop.signal.aborted) {
        log(live.rec.printer, `${shots.n} frames so far, adding the finished part`)
        await finishedPart(shots, live.stop.signal, END_FRAMES)
      }
      return seen
    } finally {
      camera.release()
    }
  }

  /** One frame's turn, then the next; whether it has seen the job run when it ends. */
  private async snapping(live: Live, shots: Shots, began: number, seen: boolean): Promise<boolean> {
    const id = live.rec.printer
    if (live.stop.signal.aborted) {
      return seen
    }
    const tick = Date.now()
    const raw = this.host.raw(id)
    const state = typeof raw?.gcode_state === "string" ? raw.gcode_state : ""
    const active = isActive(state)
    if (raw && !active && seen) {
      log(id, `${state}; the job ended`)
      return true
    }
    if (raw && !active && tick - began > START_GRACE_MS) {
      log(
        id,
        `still ${state} ${START_GRACE_MS / 60_000} min after the send; the job never started, so no timelapse`,
      )
      return false
    }
    if (active) {
      if (!seen) {
        log(id, `${state}; snapping`)
      }
      this.attach(live)
      shots.snap()
    }
    const every = live.rec.interval * 1000 * (state === "PAUSE" ? 4 : 1)
    await sleep(every - (Date.now() - tick), live.stop.signal)
    return await this.snapping(live, shots, began, seen || active)
  }

  /** The job it records, once the printer has one. */
  private attach(live: Live) {
    const job = this.host.job(live.rec.printer)
    if (live.rec.job === undefined && job !== undefined) {
      live.rec = { ...live.rec, job }
      this.save()
      this.tell(live.rec, { status: "recording" })
    }
  }
}

/** The finished part: `left` more frames, END_EVERY_MS apart. */
const finishedPart = async (shots: Shots, signal: AbortSignal, left: number): Promise<void> => {
  if (left === 0 || signal.aborted) {
    return
  }
  await sleep(END_EVERY_MS, signal)
  if (!signal.aborted) {
    shots.snap()
  }
  await finishedPart(shots, signal, left - 1)
}
