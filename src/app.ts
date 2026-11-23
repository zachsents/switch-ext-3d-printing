// Bambu printers on the LAN as an extension, the only thing that talks to them: one MQTT session and
// one camera stream each, filament, job control, the whole print (check, plan, purge, upload, start),
// timelapses, light keeping, job history and alerts. Events for what changes; a widget per printer in
// Switch's catalog: its line, filament and live camera.
//
// Commands go to real printers only with PRINTERS_COMMANDS=on; PRINTERS_SIM=on runs two simulated
// printers instead, which take every command.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

import {
  answer,
  AppEvents,
  BASIC_CATALOG,
  Caller,
  defineApp,
  surface,
  SWITCH_CATALOG,
  tool,
} from "switch-ext-kit"
import type { Draft, WidgetDef } from "switch-ext-kit"
import { Camera, tlsEye } from "./camera.ts"
import { COMMANDS, configured, readConnection, SIM, writeHost, writeName } from "./config.ts"
import type { Printer } from "./config.ts"
import { presetFor } from "./filaments.ts"
import { ftpsCard } from "./files.ts"
import type { Card } from "./files.ts"
import { history, loadJobs, record, saveJobs } from "./jobs.ts"
import type { Job, JobTimelapse } from "./jobs.ts"
import { libraryJson } from "./lib.ts"
import { Link, mqttDial } from "./link.ts"
import { noActivities } from "./live.ts"
import type { LiveActivities, PrintActivity } from "./live.ts"
import {
  extrude,
  filamentSetting,
  fromLibrary,
  jobControl,
  ledctrl,
  printSpeed,
  temps,
  unload,
} from "./payloads.ts"
import { SIM_PRINTERS, simCard, simDial, simEye } from "./sim.ts"
import {
  EVENTS,
  FilamentRanOut,
  JobFailed,
  JobFinished,
  JobProgress,
  JobStarted,
  PrinterError,
  PrinterRenamed,
  SlotsChanged,
  StateChanged,
} from "./events.ts"
import { isActive, slotsOf, viewOf } from "./state.ts"
import type { Raw, View } from "./state.ts"
import { makingTools } from "./making.ts"
import { INTERVAL_S, MIN_INTERVAL_S, plateStem, Recorders, timelapseRoot } from "./timelapse.ts"
import { track } from "./track.ts"
import type { Seen } from "./track.ts"
import { lineOf, SWAP } from "./board.ts"

const APP = "printers"

const PRINTERS: readonly Printer[] = SIM ? SIM_PRINTERS : configured()

// ── Printers ──

const HMS_DIRS = [
  path.join(homedir(), "Library", "Application Support", "BambuStudio", "hms"),
  "/Applications/BambuStudio.app/Contents/Resources/hms",
]

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const field = (x: unknown, key: string): unknown => (isRecord(x) ? x[key] : undefined)

/** One HMS table's English texts, by code. */
const textsIn = (table: unknown, into: Map<string, string>) => {
  const data = field(table, "data")
  for (const part of [
    field(field(data, "device_error"), "en"),
    field(field(data, "device_hms"), "en"),
  ]) {
    for (const e of Array.isArray(part) ? part : []) {
      const ecode = field(e, "ecode")
      const intro = field(e, "intro")
      if (
        typeof ecode === "string" &&
        typeof intro === "string" &&
        !into.has(ecode.toUpperCase())
      ) {
        into.set(ecode.toUpperCase(), intro)
      }
    }
  }
}

/** Bambu's English texts for error codes, from Bambu Studio's HMS tables; codes alone without. */
const loadTexts = () => {
  const texts = new Map<string, string>()
  for (const dir of HMS_DIRS.filter((d) => existsSync(d))) {
    for (const f of readdirSync(dir).filter((x) => /^hms_en_.+\.json$/u.test(x))) {
      try {
        textsIn(JSON.parse(readFileSync(path.join(dir, f), "utf-8")), texts)
      } catch {
        // A table that won't parse: its codes show bare.
      }
    }
  }
  return texts
}

interface Entry {
  /** Replaced when it's renamed. */
  printer: Printer
  readonly link: Link
  readonly camera: Camera
}

const ignore = () => {
  // The iPhone's tool failing must not stop the extension.
}

const activityOf = (v: View): PrintActivity => ({
  printer: v.id,
  name: v.name,
  file: v.file ?? "",
  phase: v.phase,
  percent: v.percent,
  layer: v.layer,
  layers: v.layers,
  endsAt: v.endsAt,
})

// ── Heat holds ──

/** How long a heat hold lasts unless it's given more. */
export const HOLD_MS = 45 * 60_000
/** A hold's targets are set again only once they've been off this long, so a print starting isn't
 * fought, and never more often than every five seconds. */
const SETTLE_MS = 2000
const RESEND_MS = 5000
/** The printer's own filament routines' stages (changing, unloading, loading): a hold waits. */
const FILAMENT_STAGES = new Set([4, 22, 24])

/**
 * Heat kept on an idle printer: it drops an idle target by itself, so the hold sets it again
 * until it runs out (then cools the printer), a job starts, or it's let go.
 */
export interface Hold {
  readonly nozzle: number
  readonly bed?: number
  until: number
  slippedAt: number | undefined
  sentAt: number
}

const target = (raw: Raw, key: string) => (typeof raw[key] === "number" ? Math.round(raw[key]) : -1)

/** What print sent, by printer: its job keeps the light on when it shows within the hour. */
interface Sent {
  readonly file: string
  readonly at: number
  readonly light: boolean
  /** The caller's space, if the core said. */
  readonly space: string | null
}
const SENT_MS = 3_600_000
/** The chamber light is sent again at most this often while a job keeps it on. */
const LIGHT_MS = 300_000
/** Printers down this long are listened for by serial, at most every REHOME_MS. */
const DOWN_MS = 600_000
const REHOME_MS = 1_800_000

/** Each printer's last print's spool signature (the CLI's last-spool-<id>.json), in the extension's folder. */
const LAST_SPOOL = path.resolve("last-spool.json")
const decodeSpools = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const lastSpools = (): Record<string, unknown> => {
  if (!existsSync(LAST_SPOOL)) {
    return {}
  }
  const read = decodeSpools(readFileSync(LAST_SPOOL, "utf-8"))
  return read._tag === "Some" ? read.value : {}
}
const keepSpool = (id: string, signature: unknown) => {
  writeFileSync(`${LAST_SPOOL}.tmp`, JSON.stringify({ ...lastSpools(), [id]: signature }))
  renameSync(`${LAST_SPOOL}.tmp`, LAST_SPOOL)
}

export class Printers extends Context.Service<
  Printers,
  {
    readonly entries: readonly Entry[]
    readonly view: (e: Entry) => View
    readonly card: Card
    /** Heat holds, by printer id. */
    readonly holds: Map<string, Hold>
    /** When the plate a printer shows finished, as its kept job says; null if not seen. */
    readonly doneAt: (v: View) => number | null
    readonly emit: (draft: Draft) => void
    /** Each printer's job, by printer id. */
    readonly jobs: ReadonlyMap<string, Job>
    readonly sent: Map<string, Sent>
    readonly recorders: Recorders
  }
>()("switch/printers/Printers") {
  static readonly layer = (options: { readonly activities?: LiveActivities } = {}) =>
    Layer.effect(
      Printers,
      Effect.gen(function* making() {
        const events = yield* AppEvents
        const activities = options.activities ?? noActivities
        const texts = loadTexts()
        const emit = (draft: Draft) => {
          Effect.runFork(Effect.ignore(events.emit(draft)))
        }

        const entries: Entry[] = PRINTERS.map((printer) => {
          const link = new Link(printer.id, SIM ? simDial : mqttDial, COMMANDS)
          const camera = new Camera(printer.id, SIM ? simEye : tlsEye)
          return { printer, link, camera }
        })
        const holds = new Map<string, Hold>()
        const view = (e: Entry): View => {
          const v = viewOf(e.printer, e.link.raw, e.link.online(), texts, Date.now())
          const h = holds.get(e.printer.id)
          return h
            ? {
                ...v,
                hold: {
                  nozzle: h.nozzle,
                  ...(h.bed === undefined ? {} : { bed: h.bed }),
                  until: h.until,
                },
              }
            : v
        }

        /** Keeps a printer's hold: its targets set again when they slip, the printer cooled when it runs out. */
        const keep = (e: Entry) => {
          const { id } = e.printer
          const h = holds.get(id)
          const { link } = e
          if (!h || !link.online()) {
            return
          }
          const { raw } = link
          if (isActive(stateOf(raw))) {
            // A job took over the heaters: the hold is done.
            holds.delete(id)
            return
          }
          if (typeof raw.stg_cur === "number" && FILAMENT_STAGES.has(raw.stg_cur)) {
            return
          }
          const now = Date.now()
          if (now >= h.until) {
            holds.delete(id)
            link.send(temps(link.nextSeq(), 0, h.bed === undefined ? undefined : 0)).catch(ignore)
            return
          }
          const slipped =
            target(raw, "nozzle_target_temper") !== h.nozzle ||
            (h.bed !== undefined && target(raw, "bed_target_temper") !== h.bed)
          if (!slipped) {
            h.slippedAt = undefined
            return
          }
          h.slippedAt ??= now
          if (now - h.slippedAt >= SETTLE_MS && now - h.sentAt >= RESEND_MS) {
            h.sentAt = now
            link.send(temps(link.nextSeq(), h.nozzle, h.bed)).catch(ignore)
          }
        }

        const seen = new Map<string, Seen>()
        /** Each printer's job, kept across restarts: its duration, its plate's "Done 12:23 AM". */
        const jobs = loadJobs()
        const sent = new Map<string, Sent>()
        const setJob = (j: Job) => {
          jobs.set(j.printer, j)
          saveJobs(jobs)
          record(j)
        }

        /** A job's chamber light kept on while it runs. */
        const keepLight = (e: Entry) => {
          const j = jobs.get(e.printer.id)
          const now = Date.now()
          if (j?.keepLight !== true || j.endedAt !== null || !e.link.online()) {
            return
          }
          const v = view(e)
          if (isActive(v.state) && v.light === false && now - j.lightAt > LIGHT_MS) {
            const lit = { ...j, lightAt: now }
            jobs.set(lit.printer, lit)
            saveJobs(jobs)
            e.link.send(ledctrl(e.link.nextSeq(), true)).catch(ignore)
          }
        }

        /** What changed since this printer's last report, as events, its job and the print's activity. */
        const step = (e: Entry) => {
          const v = view(e)
          const now = Date.now()
          const stage = typeof e.link.raw.stg_cur === "number" ? e.link.raw.stg_cur : undefined
          const kept = jobs.get(v.id)
          const out = track(seen.get(v.id), v, stage, now, kept, e.link.seenAt || now)
          if (out.seen) {
            seen.set(v.id, out.seen)
          }
          for (const j of out.jobs) {
            const s = sent.get(v.id)
            const ours =
              jobs.get(v.id)?.id !== j.id &&
              s !== undefined &&
              plateStem(s.file) === j.file &&
              now - s.at < SENT_MS
            setJob(
              ours
                ? { ...j, keepLight: s.light, ...(s.space === null ? {} : { space: s.space }) }
                : j,
            )
          }
          for (const d of out.drafts) {
            if (
              e.printer.jobOutcomes ||
              (d.type !== JobFinished.type && d.type !== JobFailed.type)
            ) {
              emit(d)
            }
          }
          if (out.activity) {
            const { kind, key } = out.activity
            const space = jobs.get(v.id)?.space
            const run =
              kind === "start"
                ? activities.start(key, activityOf(v), space)
                : activities[kind](key, activityOf(v))
            run.catch(ignore)
          }
        }

        const recorders = new Recorders({
          raw: (id) => {
            const e = entries.find((x) => x.printer.id === id)
            return e?.link.online() === true ? e.link.raw : undefined
          },
          camera: (id) => {
            const e = entries.find((x) => x.printer.id === id)
            if (!e) {
              throw new Error(`No printer ${id}`)
            }
            return e.camera
          },
          name: (id) => entries.find((x) => x.printer.id === id)?.printer.name ?? id,
          job: (id) => {
            const j = jobs.get(id)
            return j?.endedAt === null ? j.id : undefined
          },
          timelapse: (printer: string, job: string, tl: JobTimelapse) => {
            const j = jobs.get(printer)
            if (j?.id === job) {
              setJob({ ...j, timelapse: tl })
              return
            }
            const old = history().find((x) => x.id === job)
            if (old) {
              record({ ...old, timelapse: tl })
            }
          },
          emit,
        })
        recorders.resume()

        /** Down printers heard at a new address (DHCP moved them) get their env file's host rewritten. */
        const downSince = new Map<string, number>()
        let rehomedAt = 0
        const rehome = async () => {
          const now = Date.now()
          const down = entries.filter((e) => now - (downSince.get(e.printer.id) ?? now) > DOWN_MS)
          if (SIM || down.length === 0 || now - rehomedAt < REHOME_MS) {
            return
          }
          rehomedAt = now
          const serials = new Map(down.map((e) => [readConnection(e.printer.id).serial, e]))
          const heard = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
          )(
            await libraryJson(
              ["listen", ...[...serials.keys()].flatMap((x) => ["--serial", x])],
              60_000,
            ),
          )
          for (const [serial, host] of Object.entries(heard)) {
            const e = serials.get(serial)
            if (e && readConnection(e.printer.id).host !== host) {
              console.error(
                `${e.printer.id}: moved to ${host} (heard by serial); rewrote its env file`,
              )
              writeHost(e.printer.id, host)
              e.link.reconnect()
            }
          }
        }

        for (const e of entries) {
          e.link.subscribe(() => {
            step(e)
            keep(e)
            keepLight(e)
          })
        }
        const keeper = setInterval(() => {
          for (const e of entries) {
            keep(e)
            keepLight(e)
          }
        }, 2000)
        // Offline only counts after GONE_MS, which no report marks.
        const ticker = setInterval(() => {
          for (const e of entries) {
            step(e)
            if (e.link.online()) {
              downSince.delete(e.printer.id)
            } else if (!downSince.has(e.printer.id)) {
              downSince.set(e.printer.id, Date.now())
            }
          }
          void (async () => {
            try {
              await rehome()
            } catch (error) {
              console.error(`rehome: ${String(error)}`)
            }
          })()
        }, 5000)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearInterval(ticker)
            clearInterval(keeper)
            for (const e of entries) {
              e.camera.stop()
              e.link.close()
            }
          }),
        )
        return {
          entries,
          view,
          card: SIM ? simCard : ftpsCard,
          holds,
          doneAt: (v: View) => {
            const job = jobs.get(v.id)
            return job?.outcome === "finished" && job.file === v.file ? job.endedAt : null
          },
          emit,
          jobs,
          sent,
          recorders,
        }
      }),
    )
}

// ── Tools ──

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

/** A printer by its id or its name, in any case. */
const find = (printers: typeof Printers.Service, name: string) => {
  const wanted = name.trim().toLowerCase()
  const e = printers.entries.find(
    (x) => x.printer.id === wanted || x.printer.name.toLowerCase() === wanted,
  )
  if (!e) {
    const known = printers.entries.map((x) => x.printer.name).join(", ")
    return Effect.fail(new Error(`No printer ${name} (${known || "none set up"})`))
  }
  return Effect.succeed(e)
}

/** Sends, then waits for the printer's reports to show it. */
const sendAndConfirm = async (
  link: Link,
  request: Parameters<Link["send"]>[0],
  confirmed: (raw: Raw) => boolean,
  ms: number,
) => {
  const reply = await link.send(request)
  if (reply && !reply.ok) {
    throw new Error(`Refused${reply.reason === undefined ? "" : `: ${reply.reason}`}`)
  }
  if (await link.waitFor(confirmed, ms)) {
    return
  }
  if (!reply) {
    throw new Error("No answer")
  }
}

const stateOf = (raw: Raw) => (typeof raw.gcode_state === "string" ? raw.gcode_state : "")

const which = Schema.Struct({ printer: Schema.String })

const status = tool(
  "status",
  {
    description:
      "Every printer, or one: state, progress, time left, layer, temperatures, the AMS slots and errors.",
    readOnly: true,
    input: Schema.Struct({ printer: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const printers = yield* Printers
      const chosen =
        input.printer === undefined ? printers.entries : [yield* find(printers, input.printer)]
      return { asOf: Date.now(), printers: chosen.map(printers.view) }
    }),
)

const board = tool(
  "board",
  {
    description: "Every printer at a glance: its line and its filament slots.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* drawing() {
      const printers = yield* Printers
      return {
        printers: printers.entries.map((e) => {
          const v = printers.view(e)
          return lineOf(v, printers.doneAt(v))
        }),
      }
    }),
)

const control = (action: "pause" | "resume" | "stop", description: string) =>
  tool(action, { description, input: which }, (input) =>
    Effect.gen(function* controlling() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const { link } = e
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      const state = stateOf(link.raw)
      if (!isActive(state)) {
        return yield* Effect.fail(new Error(`${e.printer.name} isn't printing`))
      }
      if (action === "resume" && state !== "PAUSE") {
        return yield* Effect.fail(new Error(`${e.printer.name} isn't paused`))
      }
      if (action === "pause" && state === "PAUSE") {
        return yield* Effect.fail(new Error(`${e.printer.name} is already paused`))
      }
      const confirmed = {
        pause: (r: Raw) => stateOf(r) === "PAUSE",
        resume: (r: Raw) => stateOf(r) === "RUNNING",
        stop: (r: Raw) => !isActive(stateOf(r)),
      }[action]
      yield* attempt(async () => {
        await sendAndConfirm(link, jobControl(link.nextSeq(), action), confirmed, 15_000)
      })
      return printers.view(e)
    }),
  )

const pause = control("pause", "Pause a printer's job.")
const resume = control("resume", "Resume a paused job.")
const stop = control("stop", "Stop a printer's job. It can't be resumed.")

const setFilament = tool(
  "set_filament",
  {
    description:
      'Set what an AMS slot (A1-A4) or the external spool ("ext") holds: type (PLA, PETG, ASA, ABS, TPU), color (RRGGBB) and brand (Generic when left out; Bambu, Polymaker...). Only tells the printer; it moves no filament.',
    input: Schema.Struct({
      printer: Schema.String,
      slot: Schema.String,
      type: Schema.String,
      color: Schema.String,
      brand: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* setting() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const { link } = e
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      const color = input.color.replace(/^#/u, "").toUpperCase()
      if (!/^[0-9A-F]{6}$/u.test(color)) {
        return yield* Effect.fail(new Error(`Color ${input.color} isn't RRGGBB`))
      }
      const preset = presetFor(input.type, input.brand)
      if (!preset) {
        return yield* Effect.fail(new Error(`No ${input.brand ?? "Generic"} ${input.type} preset`))
      }
      const v = printers.view(e)
      const slotName = input.slot.trim().toUpperCase()
      const ext = slotName === "EXT" || slotName === "EXTERNAL"
      const slot = v.slots.find((s) => s.slot === slotName)
      if (!ext && !slot) {
        const has = v.slots.map((s) => s.slot).join(", ")
        return yield* Effect.fail(
          new Error(
            `${e.printer.name} has no slot ${input.slot}${has ? ` (${has}, ext)` : " (ext)"}`,
          ),
        )
      }
      if (slot?.rfid === true) {
        return yield* Effect.fail(new Error(`${slotName} holds a Bambu spool; its tag sets it`))
      }
      const where = slot
        ? { ams: Math.floor(slot.tray / 4), tray: slot.tray % 4 }
        : { ams: 255, tray: 254 }
      const shows = (r: Raw) => {
        const after = viewOf(e.printer, r, true, new Map(), Date.now())
        const got = slot ? after.slots.find((s) => s.slot === slotName) : after.spool
        return got?.type === preset.type && got.color === color
      }
      yield* attempt(async () => {
        await sendAndConfirm(
          link,
          filamentSetting(link.nextSeq(), where, preset, color),
          shows,
          8000,
        )
      })
      return printers.view(e)
    }),
)

const files = tool(
  "files",
  {
    description: "The files on a printer's card (plates sent to it, timelapses aside).",
    readOnly: true,
    input: which,
  },
  (input) =>
    Effect.gen(function* listing() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const all = yield* attempt(async () => await printers.card.list(e.printer.id))
      return { printer: e.printer.id, files: all.toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)) }
    }),
)

const camera = tool(
  "camera",
  { description: "A printer's camera, now.", readOnly: true, input: which },
  (input) =>
    Effect.gen(function* looking() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const frame = yield* attempt(async () => await e.camera.frame())
      if (!frame) {
        return yield* Effect.fail(new Error(e.camera.problem || "No picture"))
      }
      const data = frame.jpeg.toString("base64")
      return answer(
        { printer: e.printer.id, at: frame.at, source: frame.source, mimeType: "image/jpeg", data },
        [{ type: "image", data, mimeType: "image/jpeg" }],
      )
    }),
)

// ── Printing ──

const loadedFields = Schema.Struct({
  tray_info_idx: Schema.String,
  tray_type: Schema.String,
  tray_color: Schema.String,
  nozzle_temp_min: Schema.Finite,
  nozzle_temp_max: Schema.Finite,
})
const wire = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.Unknown),
])
const planned = Schema.Struct({
  printer: Schema.String,
  check: Schema.Array(Schema.String),
  errors: Schema.Finite,
  setting: Schema.NullOr(
    Schema.Struct({
      ams_id: Schema.Finite,
      tray_id: Schema.Finite,
      where: Schema.String,
      fields: loadedFields,
      tray: Schema.NullOr(Schema.Finite),
    }),
  ),
  plan: Schema.String,
  notes: Schema.Array(Schema.String),
  purge: Schema.Boolean,
  signature: Schema.Unknown,
  send: Schema.String,
  payload: Schema.Struct({
    print: Schema.StructWithRest(Schema.Struct({ command: Schema.String }), [
      Schema.Record(Schema.String, wire),
    ]),
  }),
})
const decodePlan = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([Schema.Struct({ error: Schema.String }), planned])),
)
type Planned = typeof planned.Type

/** The library's print planning: the CLI's `bambu print` up to the send (lib/bambu.py plan). */
const planPrint = async (request: Record<string, unknown>): Promise<Planned> => {
  const said = decodePlan(await libraryJson(["plan"], 5 * 60_000, JSON.stringify(request)))
  if ("error" in said) {
    throw new Error(said.error)
  }
  return said
}

const text = (x: unknown) => (typeof x === "string" ? x : undefined)

/** Whether the printer reports what a loaded setting set: that type and color there (the CLI's loaded_took). */
const loadedTook = (raw: Raw, setting: NonNullable<Planned["setting"]>) => {
  const want = setting.fields
  const vt: Record<string, unknown> =
    typeof raw.vt_tray === "object" && raw.vt_tray !== null ? { ...raw.vt_tray } : {}
  const slot = slotsOf(raw).find((x) => x.tray === setting.tray)
  const type = setting.tray === null ? text(vt.tray_type) : slot?.type
  const color = setting.tray === null ? text(vt.tray_color)?.slice(0, 6).toUpperCase() : slot?.color
  return (
    type !== undefined &&
    type !== "" &&
    (want.tray_type.split(";")[0] ?? "").toUpperCase() === type.toUpperCase() &&
    color === want.tray_color.slice(0, 6)
  )
}

/** Sends a command and checks its reply, when one came. */
const sendChecked = async (link: Link, request: Parameters<Link["send"]>[0]) => {
  const reply = await link.send(request)
  if (reply && !reply.ok) {
    throw new Error(`Refused${reply.reason === undefined ? "" : `: ${reply.reason}`}`)
  }
}

/** How long a sent job may take to show on the printer. */
const SHOW_MS = 240_000

/**
 * The slice's one filament was just put on: the printer is told so, from the slice, and must report
 * it within 15 s (the CLI's print --loaded). What it set, as a note.
 */
const putLoaded = async (e: Entry, setting: NonNullable<Planned["setting"]>) => {
  const { link } = e
  const what = `${setting.fields.tray_type} #${setting.fields.tray_color.slice(0, 6)}`
  await link.send(
    fromLibrary(link.nextSeq(), "print", {
      command: "ams_filament_setting",
      ams_id: setting.ams_id,
      tray_id: setting.tray_id,
      ...setting.fields,
    }),
  )
  if (!(await link.waitFor((r) => loadedTook(r, setting), 15_000))) {
    throw new Error(
      `not sending to ${e.printer.name}: it didn't report its ${setting.where} as ${what} within 15 s of being set; check it with status`,
    )
  }
  return `loaded: set ${e.printer.name}'s ${setting.where} to ${what}, what's on it now`
}

/**
 * Uploads the plate (skipped when a same-size copy is on the card already, as the CLI's upload) and
 * starts it with the library's project_file. What was sent is kept, for its job's light.
 */
const sendPlate = async (
  printers: typeof Printers.Service,
  e: Entry,
  plate: {
    readonly file: string
    readonly send: string
    readonly payload: Planned["payload"]
    readonly light: boolean
    readonly space: string | null
  },
) => {
  const { link } = e
  const { size } = statSync(plate.send)
  const there = await printers.card.list(e.printer.id)
  if (!there.some((f) => f.name === plate.file && f.size === size)) {
    await printers.card.upload(e.printer.id, plate.send, plate.file)
  }
  printers.sent.set(e.printer.id, {
    file: plate.file,
    at: Date.now(),
    light: plate.light,
    space: plate.space,
  })
  await sendChecked(link, fromLibrary(link.nextSeq(), "print", plate.payload.print))
}

/** Every printer's report for the library to plan against, or why there's none. */
const statesOf = (printers: typeof Printers.Service) =>
  Object.fromEntries(
    printers.entries.map((x) => [
      x.printer.id,
      { state: x.link.online() ? x.link.raw : "offline", model: x.printer.model },
    ]),
  )

/** print's input as the library's plan takes it. */
const printRequest = (
  input: {
    readonly slots?: readonly string[]
    readonly force?: boolean
    readonly quickStart?: boolean
    readonly dryRun?: boolean
    readonly level?: boolean
    readonly vibration?: boolean
  },
  file: string,
) => ({
  file,
  slots: input.slots ?? [],
  force: input.force ?? false,
  quick_start: input.quickStart ?? false,
  dry_run: input.dryRun ?? false,
  level: input.level ?? true,
  vibration: input.vibration ?? false,
  last: lastSpools(),
})

/** The print's timelapse, started; a note when it says something, or couldn't start. */
const startTimelapse = (
  printers: typeof Printers.Service,
  e: Entry,
  name: string,
  interval: number,
) =>
  Effect.promise(async () => {
    try {
      const rec = await printers.recorders.start(e.printer.id, name, interval)
      return rec.note === undefined ? [] : [rec.note]
    } catch (error) {
      return [
        `timelapse: couldn't start a recording for ${e.printer.name} (${String(error)}); the print itself was sent`,
      ]
    }
  })

const print = tool(
  "print",
  {
    description:
      "Send a sliced plate (.gcode.3mf on this machine) to a printer, or \"auto\" (an idle printer with the plate's filament loaded), and start it: the pre-print check (it refuses on errors unless force), the AMS plan, the full purge after a spool change (quickStart skips it), the upload, the start, a timelapse (timelapse false skips it; interval seconds, default 15), then waits until the printer shows the job. Only on a cleared bed, and only when the user wants it printed. slots: the AMS slot per filament in order (A1, A3) or ext; by default each filament takes the slot holding its type and color. loaded: the slice's one filament was just put on; that spool or slot is set from the slice first. light: keep the chamber light on through the job. level (default true), vibration: calibrations. dryRun runs the check and the plan and sends nothing.",
    input: Schema.Struct({
      printer: Schema.String,
      file: Schema.String,
      slots: Schema.optionalKey(Schema.Array(Schema.String)),
      level: Schema.optionalKey(Schema.Boolean),
      vibration: Schema.optionalKey(Schema.Boolean),
      dryRun: Schema.optionalKey(Schema.Boolean),
      loaded: Schema.optionalKey(Schema.Boolean),
      quickStart: Schema.optionalKey(Schema.Boolean),
      force: Schema.optionalKey(Schema.Boolean),
      timelapse: Schema.optionalKey(Schema.Boolean),
      interval: Schema.optionalKey(Schema.Finite),
      light: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.gen(function* printing() {
      const printers = yield* Printers
      const caller = yield* Caller
      const file = path.resolve(input.file.replace(/^~\//u, `${homedir()}/`))
      const name = path.basename(file)
      const dryRun = input.dryRun ?? false
      const interval = input.interval ?? INTERVAL_S
      if (!name.endsWith(".gcode.3mf") || !existsSync(file)) {
        return yield* Effect.fail(new Error(`No plate at ${input.file}`))
      }
      if (interval < MIN_INTERVAL_S) {
        return yield* Effect.fail(new Error(`A timelapse interval is at least ${MIN_INTERVAL_S} s`))
      }
      const chosen =
        input.printer.trim().toLowerCase() === "auto"
          ? "auto"
          : (yield* find(printers, input.printer)).printer.id
      const states = () => statesOf(printers)
      const request = printRequest(input, file)
      const first = yield* attempt(
        async () =>
          await planPrint({
            ...request,
            printer: chosen,
            printers: states(),
            loaded: input.loaded ?? false,
            check: true,
          }),
      )
      const e = yield* find(printers, first.printer)
      const { link } = e
      if (dryRun) {
        return {
          printer: printers.view(e),
          job: null,
          plan: first.plan,
          notes: first.notes,
          check: first.check,
          purge: first.purge,
          payload: first.payload,
        }
      }
      if (!link.commands) {
        return yield* Effect.fail(new Error("Commands are off"))
      }
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      const notes = [...first.notes]
      let plan = first
      const { setting } = first
      if (setting) {
        notes.push(yield* attempt(async () => await putLoaded(e, setting)))
        plan = yield* attempt(
          async () =>
            await planPrint({
              ...request,
              printer: e.printer.id,
              printers: states(),
              loaded: false,
              check: false,
            }),
        )
        notes.push(...plan.notes)
      }
      const { send, payload, signature } = plan
      if (send !== file) {
        notes.push(
          `${e.printer.name}: the spool changed since its last print (or isn't known), so this print runs the full 100 mm purge (skip with quickStart)`,
        )
      }
      yield* attempt(async () => {
        await sendPlate(printers, e, {
          file: name,
          send,
          payload,
          light: input.light ?? false,
          space: caller.space,
        })
        keepSpool(e.printer.id, signature)
      })
      if (input.timelapse !== false) {
        notes.push(...(yield* startTimelapse(printers, e, name, interval)))
      }
      const shown = yield* attempt(
        async () => await link.waitFor((r) => isActive(stateOf(r)), SHOW_MS),
      )
      if (!shown) {
        notes.push(`${e.printer.name} doesn't show the job yet`)
      }
      const job = printers.jobs.get(e.printer.id)
      return {
        printer: printers.view(e),
        job: job?.endedAt === null && job.file === plateStem(name) ? job.id : null,
        plan: plan.plan,
        notes,
        check: first.check,
        purge: plan.purge,
      }
    }),
)

const speed = tool(
  "speed",
  {
    description:
      "The running job's speed: silent (about half speed, much quieter, for overnight near sleepers), standard, sport, ludicrous. It lasts until the job ends.",
    input: Schema.Struct({
      printer: Schema.String,
      level: Schema.Literals(["silent", "standard", "sport", "ludicrous"]),
    }),
  },
  (input) =>
    Effect.gen(function* speeding() {
      const printers = yield* Printers
      const e = yield* commandable(printers, input.printer)
      const { link } = e
      const state = stateOf(link.raw)
      if (!isActive(state)) {
        return yield* Effect.fail(
          new Error(
            `${e.printer.name} has no running job (${state}); start the print, then set its speed`,
          ),
        )
      }
      yield* attempt(async () => {
        await sendChecked(link, printSpeed(link.nextSeq(), input.level))
      })
      return printers.view(e)
    }),
)

const light = tool(
  "light",
  {
    description: "The chamber light. On for prints after dark, so the camera and timelapse see.",
    input: Schema.Struct({ printer: Schema.String, on: Schema.Boolean }),
  },
  (input) =>
    Effect.gen(function* lighting() {
      const printers = yield* Printers
      const e = yield* commandable(printers, input.printer)
      const { link } = e
      yield* attempt(async () => {
        await sendAndConfirm(
          link,
          ledctrl(link.nextSeq(), input.on),
          (r) => viewOf(e.printer, r, true, new Map(), Date.now()).light === input.on,
          10_000,
        )
      })
      return printers.view(e)
    }),
)

const extrudeTool = tool(
  "extrude",
  {
    description: "Push filament through a hot nozzle (190 °C or more), in mm.",
    input: Schema.Struct({ printer: Schema.String, mm: Schema.Finite }),
  },
  (input) =>
    Effect.gen(function* extruding() {
      const printers = yield* Printers
      const e = yield* takesGcode(printers, input.printer)
      const { link } = e
      const v = printers.view(e)
      if (v.nozzle < MIN_EXTRUDE_C) {
        return yield* Effect.fail(
          new Error(`${e.printer.name}: nozzle is ${v.nozzle} C; heat it first`),
        )
      }
      yield* attempt(async () => {
        await sendChecked(link, extrude(link.nextSeq(), input.mm, 150))
      })
      return printers.view(e)
    }),
)

/** The printer's own timelapse's local name: video_2026-10-20_21-30-05.avi -> 2026-10-20_2130_<id>_native.avi. */
const nativeName = (printer: string, remote: string) => {
  const m = /(?<day>\d{4}-\d{2}-\d{2})_(?<h>\d{2})-(?<min>\d{2})/u.exec(remote)?.groups
  return m?.day === undefined
    ? `${printer}_native_${remote}`
    : `${m.day}_${m.h ?? ""}${m.min ?? ""}_${printer}_native${path.extname(remote)}`
}

const fetchNative = async (printers: typeof Printers.Service, e: Entry, all: boolean) => {
  const { id } = e.printer
  const there = await printers.card.list(id, "/timelapse")
  const videos = there
    .map((f) => f.name)
    .filter((f) => /\.(?:avi|mp4)$/iu.test(f))
    .toSorted()
  if (videos.length === 0) {
    throw new Error(`${e.printer.name} has no timelapses in /timelapse on its card`)
  }
  const root = timelapseRoot()
  const wanted = (all ? videos : videos.slice(-1)).map((remote) => ({
    remote,
    dest: path.join(root, nativeName(id, remote)),
  }))
  const had = wanted.filter((w) => existsSync(w.dest)).map((w) => w.dest)
  const saved: string[] = []
  // One at a time, as the CLI fetched them.
  const fetchEach = async (left: readonly { remote: string; dest: string }[]): Promise<void> => {
    const [w, ...rest] = left
    if (w !== undefined) {
      await printers.card.download(id, `/timelapse/${w.remote}`, w.dest)
      saved.push(w.dest)
      await fetchEach(rest)
    }
  }
  await fetchEach(wanted.filter((w) => !had.includes(w.dest)))
  return { saved, had }
}

const timelapse = tool(
  "timelapse",
  {
    description:
      "Every print records a camera timelapse (mp4 plus a .jpg preview). list: what's recording, frames folders not yet a video, and the newest videos. latest: a recording's newest frame. start/stop: a printer's recording by hand (stop still encodes what it has). fetch: the printer's own timelapse from its card (all: every one). encode: a frames folder from list into its video.",
    input: Schema.Struct({
      action: Schema.Literals(["list", "latest", "fetch", "start", "stop", "encode"]),
      printer: Schema.optionalKey(Schema.String),
      all: Schema.optionalKey(Schema.Boolean),
      frames: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* filming() {
      const printers = yield* Printers
      const { recorders } = printers
      const { action, frames } = input
      if (action === "list") {
        return recorders.list()
      }
      if (action === "encode") {
        if (frames === undefined) {
          return yield* Effect.fail(new Error("encode needs frames"))
        }
        return yield* attempt(async () => await recorders.encode(frames))
      }
      if (input.printer === undefined) {
        return yield* Effect.fail(new Error(`${action} needs a printer`))
      }
      const e = yield* find(printers, input.printer)
      const { id } = e.printer
      if (action === "latest") {
        return yield* Effect.try({
          try: () => recorders.latest(id),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
      }
      if (action === "start") {
        const job = e.link.raw.subtask_name
        const source = typeof job === "string" && job !== "" ? job : "print"
        return yield* attempt(async () => await recorders.start(id, source, INTERVAL_S))
      }
      if (action === "stop") {
        const rec = yield* attempt(async () => await recorders.stop(id))
        if (!rec) {
          return yield* Effect.fail(new Error(`${e.printer.name} has no recording`))
        }
        return { stopped: rec.printer, video: rec.out }
      }
      return yield* attempt(async () => await fetchNative(printers, e, input.all === true))
    }),
)

const jobsTool = tool(
  "jobs",
  {
    description:
      "Printing history, newest first: each job's printer, plate, start and end, outcome (finished, failed, cancelled, stopped, lost, running), reason, layers, minutes and timelapse (recording, encoding, saved with its video and preview, failed, none).",
    readOnly: true,
    input: Schema.Struct({
      printer: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const printers = yield* Printers
      const only =
        input.printer === undefined ? undefined : (yield* find(printers, input.printer)).printer.id
      const now = Date.now()
      const all = history().filter((j) => only === undefined || j.printer === only)
      return {
        jobs: all.slice(0, input.limit ?? all.length).map((j) => {
          const e = printers.entries.find((x) => x.printer.id === j.printer)
          const live =
            j.endedAt === null && e?.link.online() === true ? printers.view(e) : undefined
          return {
            id: j.id,
            printer: j.printer,
            name: j.name,
            file: j.file,
            startedAt: j.startedAt,
            endedAt: j.endedAt,
            outcome: j.outcome,
            ...(j.reason === undefined ? {} : { reason: j.reason }),
            layer: live?.layer ?? j.layer,
            layers: live?.layers ?? j.layers,
            minutes:
              j.startedAt === null ? null : Math.round(((j.endedAt ?? now) - j.startedAt) / 60_000),
            timelapse: j.timelapse,
          }
        }),
      }
    }),
)

/** The P1's limits, from Bambu Studio's printer profile. */
const MAX_NOZZLE_C = 300
const MAX_BED_C = 110
/** The nozzle won't push filament below this. */
const MIN_EXTRUDE_C = 190

/** A printer that's online and takes commands, or why not. */
const commandable = (printers: typeof Printers.Service, name: string) =>
  Effect.gen(function* checking() {
    const e = yield* find(printers, name)
    if (!e.link.commands) {
      return yield* Effect.fail(new Error("Commands are off"))
    }
    if (!e.link.online()) {
      return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
    }
    return e
  })

/** Printers that run only Bambu's own routines: no hand-sent G-code (heat, extrude, unload) reaches them. */
const STOCK_ONLY = new Set(["P2S", "H2C"])

/** A printer that takes hand-sent G-code: one of STOCK_ONLY refuses it. */
const takesGcode = (printers: typeof Printers.Service, name: string) =>
  Effect.gen(function* checking() {
    const e = yield* commandable(printers, name)
    if (STOCK_ONLY.has(e.printer.model)) {
      return yield* Effect.fail(
        new Error(
          `${e.printer.name} (${e.printer.model}) runs only Bambu's own routines; heat, extrude and unload it on its screen`,
        ),
      )
    }
    return e
  })

const heat = tool(
  "heat",
  {
    description:
      "Set the nozzle (and bed) temperature in °C; nozzle 0 with no bed (or bed 0) turns both off and ends any hold. On an idle printer it holds the heat for `minutes` (default 45), setting it again as the printer lets it drop, until it runs out (then it cools), a job starts, or hold releases it. Mid-print it corrects a wrong temperature live; say what changed and why.",
    input: Schema.Struct({
      printer: Schema.String,
      nozzle: Schema.Finite,
      bed: Schema.optionalKey(Schema.Finite),
      minutes: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* heating() {
      const printers = yield* Printers
      const e = yield* takesGcode(printers, input.printer)
      const { link } = e
      const { id } = e.printer
      const nozzle = Math.round(input.nozzle)
      const bed = input.bed === undefined ? undefined : Math.round(input.bed)
      if (
        nozzle < 0 ||
        nozzle > MAX_NOZZLE_C ||
        (bed !== undefined && (bed < 0 || bed > MAX_BED_C))
      ) {
        return yield* Effect.fail(
          new Error(`The nozzle goes to ${MAX_NOZZLE_C}° and the bed to ${MAX_BED_C}°`),
        )
      }
      const cool = nozzle === 0 && (bed ?? 0) === 0
      const printing = isActive(stateOf(link.raw))
      const sent = cool ? { nozzle: 0, bed: 0 } : { nozzle, bed }
      if (cool || printing) {
        printers.holds.delete(id)
      } else {
        const minutes = Math.min(180, Math.max(1, input.minutes ?? HOLD_MS / 60_000))
        const now = Date.now()
        printers.holds.set(id, {
          nozzle,
          ...(bed === undefined ? {} : { bed }),
          until: now + minutes * 60_000,
          slippedAt: undefined,
          sentAt: now,
        })
      }
      yield* attempt(async () => {
        await sendAndConfirm(
          link,
          temps(link.nextSeq(), sent.nozzle, sent.bed),
          (r) =>
            target(r, "nozzle_target_temper") === sent.nozzle &&
            (sent.bed === undefined || target(r, "bed_target_temper") === sent.bed),
          10_000,
        )
      })
      return printers.view(e)
    }),
)

const hold = tool(
  "hold",
  {
    description:
      "A printer's heat hold (heat starts one). extend: `minutes` more (default 45). release: stop holding; the heaters stay where they are and the printer lets them fall on its own. heat 0 cools it now.",
    input: Schema.Struct({
      printer: Schema.String,
      action: Schema.Literals(["extend", "release"]),
      minutes: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* holding() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const h = printers.holds.get(e.printer.id)
      if (!h) {
        return yield* Effect.fail(new Error(`${e.printer.name} isn't holding any heat`))
      }
      if (input.action === "release") {
        printers.holds.delete(e.printer.id)
      } else {
        const minutes = Math.min(180, Math.max(1, input.minutes ?? HOLD_MS / 60_000))
        h.until = Math.max(h.until, Date.now()) + minutes * 60_000
      }
      return printers.view(e)
    }),
)

const unloadTool = tool(
  "unload",
  {
    description:
      "Unload the external spool's filament on an idle printer: wait for the nozzle to be hot, push a little to soften the tip, then pull it up past the gears so it can be drawn out at the back. Heat it first (190° or more; the filament's own temperature).",
    input: which,
  },
  (input) =>
    Effect.gen(function* unloading() {
      const printers = yield* Printers
      const e = yield* takesGcode(printers, input.printer)
      const { link } = e
      const v = printers.view(e)
      if (isActive(v.state)) {
        return yield* Effect.fail(new Error(`${e.printer.name} is printing`))
      }
      const fed = v.slots.find((s) => s.active)
      if (fed) {
        return yield* Effect.fail(new Error(`${e.printer.name} is fed from the AMS (${fed.slot})`))
      }
      const temp = printers.holds.get(e.printer.id)?.nozzle ?? v.nozzleTarget
      if (temp < MIN_EXTRUDE_C) {
        return yield* Effect.fail(
          new Error(`Heat ${e.printer.name} first: unloading needs ${MIN_EXTRUDE_C}°`),
        )
      }
      yield* attempt(async () => {
        await sendAndConfirm(
          link,
          unload(link.nextSeq(), temp),
          (r) => r.hw_switch_state === 0,
          Math.max(40_000, (temp - v.nozzle) * 1000),
        )
      })
      return printers.view(e)
    }),
)

const rename = tool(
  "rename",
  {
    description: "Rename a printer. Names are unique, whatever the case.",
    input: Schema.Struct({ printer: Schema.String, name: Schema.String }),
  },
  (input) =>
    Effect.gen(function* renaming() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const name = input.name.trim()
      if (name === "" || /[\r\n]/u.test(name)) {
        return yield* Effect.fail(new Error("A printer needs a name on one line"))
      }
      const lower = name.toLowerCase()
      const taken = printers.entries.find(
        (x) => x !== e && (x.printer.name.toLowerCase() === lower || x.printer.id === lower),
      )
      if (taken) {
        return yield* Effect.fail(new Error(`Another printer is called ${name}`))
      }
      const from = e.printer.name
      if (!SIM) {
        yield* Effect.try({
          try: () => {
            writeName(e.printer.id, name)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
      }
      e.printer = { ...e.printer, name }
      printers.emit(PrinterRenamed.make({ printer: e.printer.id, name, from }))
      return printers.view(e)
    }),
)

const num = (r: Raw, key: string) => (typeof r[key] === "number" ? r[key] : 0)

const GOALS = ["started", "printing", "done", "layer", "percent", "change"] as const

const wait = tool(
  "wait",
  {
    description:
      "Follow a printer until something happens: started (a job is on it), printing (the first layer is going down), done (the job ended), layer or percent (reached `value`), change (its state moved). At most `minutes` (default 30, up to 180); answers how it stands either way.",
    readOnly: true,
    input: Schema.Struct({
      printer: Schema.String,
      until: Schema.Literals(GOALS),
      value: Schema.optionalKey(Schema.Finite),
      minutes: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* waiting() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const first = stateOf(e.link.raw)
      const want = input.value ?? 0
      const tests: Record<(typeof GOALS)[number], (r: Raw) => boolean> = {
        started: (r) => isActive(stateOf(r)),
        printing: (r) => stateOf(r) === "RUNNING" && num(r, "layer_num") >= 1,
        done: (r) => stateOf(r) !== "" && !isActive(stateOf(r)),
        layer: (r) => num(r, "layer_num") >= want || !isActive(stateOf(r)),
        percent: (r) => num(r, "mc_percent") >= want || !isActive(stateOf(r)),
        change: (r) => stateOf(r) !== first,
      }
      const ms = Math.min(180, Math.max(1, input.minutes ?? 30)) * 60_000
      const reached = yield* attempt(async () => await e.link.waitFor(tests[input.until], ms))
      return { reached, printer: printers.view(e) }
    }),
)

// ── Widgets ──

/**
 * One printer as its widget draws it: its line (mark, name, job, progress, time left) over a Pick
 * per AMS slot or the external spool, then its camera. Only the user's clients call it.
 */
const cardTool = (p: Printer) =>
  tool(
    `card_${p.id}`,
    { description: `${p.name} as its widget draws it.`, readOnly: true, appOnly: true },
    () =>
      Effect.gen(function* drawing() {
        const printers = yield* Printers
        const e = yield* find(printers, p.id)
        const v = printers.view(e)
        return { line: lineOf(v, printers.doneAt(v)), camera: { printer: p.id } }
      }),
  )

const cards = PRINTERS.map(cardTool)

// A printer is one cell: its live camera and its line (its name, where it's at). Every printer's
// widget keeps the camera's frame, so they sit alike.
const printerWidget = (p: Printer): WidgetDef => ({
  name: `printer-${p.id}`,
  title: p.name,
  surfaces: ["space"],
  resource: `ui://printers/printer-${p.id}`,
  size: {
    aspect: "wide",
    ratio: 16 / 9,
    min: { cols: 3, rows: 2 },
    preferred: { cols: 4, rows: 3 },
    max: { cols: 6, rows: 4 },
  },
  tool: `card_${p.id}`,
  refresh: [
    StateChanged.type,
    PrinterRenamed.type,
    JobStarted.type,
    JobProgress.type,
    JobFinished.type,
    JobFailed.type,
    FilamentRanOut.type,
    PrinterError.type,
    SlotsChanged.type,
  ],
  a2ui: () =>
    surface("printer", SWITCH_CATALOG, [
      { id: "root", component: "Column", catalogId: BASIC_CATALOG, children: ["lines", "camera"] },
      { id: "lines", component: "List", catalogId: BASIC_CATALOG, children: ["line"] },
      {
        id: "line",
        component: "Row",
        label: { "@path": "/line/label" },
        mark: { "@path": "/line/mark" },
        detail: { "@path": "/line/detail" },
        alert: { "@path": "/line/alert" },
        values: { "@path": "/line/values" },
        progress: { "@path": "/line/progress" },
        endsAt: { "@path": "/line/endsAt" },
        children: { componentId: "cell", path: "/line/cells" },
      },
      {
        id: "cell",
        component: "Pick",
        label: { "@path": "label" },
        swatch: { "@path": "swatch" },
        strong: { "@path": "strong" },
        title: { "@path": "title" },
        current: { "@path": "current" },
        args: { "@path": "args" },
        groups: SWAP,
        action: "set_filament",
      },
      {
        id: "camera",
        component: "Feed",
        action: "camera",
        args: { "@path": "/camera" },
        every: 1000,
        ratio: 16 / 9,
      },
    ]),
})

export const printersApp = defineApp<Printers>({
  name: APP,
  version: "1",
  instructions: [
    "Bambu printers on the LAN, as status lists them (model, external spool, AMS slots A1-A4). Name the printer whenever you report on one.",
    "Designing a part to print: read rules (design) first.",
    "Printing: inspect STLs made elsewhere and pick the bed face; slice; read the summary (time, filament_g, objects, bed_C) and every check WARNING, and say the time; confirm the printer's bed is clear (FINISH means the last part is likely still on it); print (dryRun first to see the plan); wait until printing. Every print records a timelapse (timelapse list; timelapse_saved says where); jobs is the history.",
    "Swapping the external spool: heat to the old filament's temperature, unload, have the new one fed in, extrude until it runs clean, then set_filament.",
    "After a spool swap, set_filament on that slot or the external spool right away: print matches the plate against what the printer reports.",
  ].join("\n"),
  tools: [
    status,
    board,
    camera,
    files,
    setFilament,
    pause,
    resume,
    stop,
    print,
    wait,
    heat,
    hold,
    unloadTool,
    rename,
    speed,
    light,
    extrudeTool,
    timelapse,
    jobsTool,
    ...makingTools,
    ...cards,
  ],
  events: EVENTS,
  widgets: PRINTERS.map(printerWidget),
})
