// A printer's state: the MQTT reports merged into one record, then read as plain facts.
import { brandOf } from "./filaments.ts"

export type Raw = Record<string, unknown>

const isRecord = (x: unknown): x is Raw => typeof x === "object" && x !== null && !Array.isArray(x)
const num = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : undefined
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined)
/** A string with something in it. */
const text = (x: unknown): string | undefined => (typeof x === "string" && x !== "" ? x : undefined)
const list = (x: unknown): readonly unknown[] => (Array.isArray(x) ? x : [])

/** The gcode_state while a job is on it. */
export const isActive = (state: string) =>
  state === "PREPARE" || state === "RUNNING" || state === "PAUSE"

/** Bambu's print_error for a print someone stopped: "The task was canceled." */
export const CANCELED = "0300400C"

/** stg_cur: the step a job is on (Bambu Studio's names, in plain words). */
const STAGES: Record<number, string> = {
  1: "Leveling",
  2: "Heating bed",
  3: "Vibration check",
  4: "Changing filament",
  5: "Paused",
  6: "Filament ran out",
  7: "Heating nozzle",
  8: "Calibrating",
  9: "Scanning bed",
  10: "Checking first layer",
  11: "Identifying plate",
  13: "Homing",
  14: "Cleaning nozzle",
  16: "Paused",
  17: "Cover fell",
  20: "Nozzle temp fault",
  21: "Bed temp fault",
  22: "Unloading",
  23: "Skipped steps",
  24: "Loading",
  26: "AMS lost",
  27: "Fan too slow",
  29: "Cooling chamber",
  30: "Paused",
  32: "Filament tangled",
  33: "Cutter error",
  34: "First layer problem",
  35: "Nozzle clog",
}

/** The stage a filament run-out pauses on. */
export const RUN_OUT_STAGE = 6

export interface Message {
  /** A status push to merge, if this was one. */
  readonly push?: Raw
  /** A reply to one of our requests, by its sequence_id. */
  readonly reply?: { readonly seq: string; readonly ok: boolean; readonly reason?: string }
}

/** One MQTT message from the printer. */
export const parseMessage = (payload: string): Message => {
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return {}
  }
  if (!isRecord(json)) {
    return {}
  }
  const print = isRecord(json.print) ? json.print : undefined
  const system = isRecord(json.system) ? json.system : undefined
  const push =
    print && (print.command === "push_status" || print.command === undefined) ? print : undefined
  const body = [print, system].find(
    (b) => b !== undefined && b !== push && typeof b.sequence_id === "string",
  )
  if (!body) {
    return push ? { push } : {}
  }
  const result = str(body.result) ?? ""
  const reason = str(body.reason)
  const reply = {
    seq: String(body.sequence_id),
    ok: !/fail/iu.test(result),
    ...(reason === undefined ? {} : { reason }),
  }
  return push ? { push, reply } : { reply }
}

/** Lists of records with ids merged by id, each record key by key; what the old list had and the new lacks stays. */
const byId = (old: unknown, now: unknown, inner?: (a: Raw, b: Raw) => Raw): unknown => {
  if (!Array.isArray(old) || !Array.isArray(now)) {
    return now
  }
  const out: unknown[] = old.filter(isRecord).map((x) => ({ ...x }))
  for (const n of now) {
    if (!isRecord(n)) {
      continue
    }
    const at = out.findIndex((o) => isRecord(o) && o.id === n.id)
    const was = at === -1 ? undefined : out[at]
    if (was === undefined || !isRecord(was)) {
      out.push(n)
    } else {
      out[at] = inner ? inner(was, n) : { ...was, ...n }
    }
  }
  return out
}

const unitMerge = (a: Raw, b: Raw): Raw => ({ ...a, ...b, tray: byId(a.tray, b.tray) })

/**
 * The state with a push merged in. Pushes carry only what changed, and the AMS block too: a push
 * can bring `ams` with just `tray_now`, or a unit with only the slot that changed, or a slot with
 * only its new keys, so units and slots are merged by id, key by key. Whether a slot holds a spool
 * is read from `tray_exist_bits` (slotOf), so a slot emptied keeps no stale type.
 */
export const mergePush = (raw: Raw, push: Raw): Raw => {
  const merged = { ...raw, ...push }
  if (isRecord(raw.ams) && isRecord(push.ams)) {
    merged.ams = { ...raw.ams, ...push.ams, ams: byId(raw.ams.ams, push.ams.ams, unitMerge) }
  }
  if (Array.isArray(push.vir_slot)) {
    merged.vir_slot = byId(raw.vir_slot, push.vir_slot)
  }
  if (isRecord(raw.vt_tray) && isRecord(push.vt_tray)) {
    merged.vt_tray = { ...raw.vt_tray, ...push.vt_tray }
  }
  return merged
}

/** A full report: the state and both targets. A session's first push can be a delta. */
export const isFull = (raw: Raw) =>
  str(raw.gcode_state) !== undefined &&
  num(raw.nozzle_target_temper) !== undefined &&
  num(raw.bed_target_temper) !== undefined

export interface Slot {
  /** As the printer's screen names it: A1..A4, B1.. */
  readonly slot: string
  /** Global tray number: A1 = 0. */
  readonly tray: number
  readonly loaded: boolean
  readonly type?: string
  /** RRGGBB. */
  readonly color?: string
  readonly brand?: string
  /** Percent left, when the spool says. */
  readonly remain?: number
  /** A Bambu spool: its tag sets it. */
  readonly rfid: boolean
  /** Fed to the toolhead now. */
  readonly active: boolean
}

const hex6 = (color: string | undefined) =>
  color === undefined || color.length < 6 ? undefined : color.slice(0, 6).toUpperCase()

const tagged = (x: unknown) => {
  const s = str(x)
  return s !== undefined && s.replaceAll("0", "") !== ""
}

/** An AMS HT's unit id: 128 on. It has one slot. */
const HT = 128

/** A slot as the printer's screen names it: A1..D4, HT1.. for an AMS HT. */
const slotName = (unit: number, tray: number) =>
  unit >= HT ? `HT${unit - HT + 1}` : `${"ABCD"[unit] ?? String(unit)}${tray + 1}`

const slotOf = (t: Raw, tray: number, now: string, exist: number | undefined): Slot => {
  const unit = Math.floor(tray / 4)
  // A slot emptied can keep its last type in the merged state: the existence bits say (units A-D).
  const there =
    exist === undefined || unit >= 4 ? undefined : Math.floor(exist / 2 ** tray) % 2 === 1
  const type = there === false ? undefined : text(t.tray_type)
  const color = type === undefined ? undefined : hex6(str(t.tray_color))
  const brand = text(t.tray_sub_brands) ?? brandOf(str(t.tray_info_idx) ?? "")
  const remain = num(t.remain)
  return {
    slot: slotName(unit, tray % 4),
    tray,
    loaded: there ?? type !== undefined,
    ...(type === undefined ? {} : { type }),
    ...(color === undefined ? {} : { color }),
    ...(brand === undefined || type === undefined ? {} : { brand }),
    ...(remain === undefined || remain < 0 || type === undefined ? {} : { remain }),
    rfid: type !== undefined && (tagged(t.tray_uuid) || tagged(t.tag_uid)),
    active: now === String(tray),
  }
}

/** Every AMS slot, in order; empty for a printer without one. */
export const slotsOf = (raw: Raw): Slot[] => {
  const ams = isRecord(raw.ams) ? raw.ams : {}
  const now = str(ams.tray_now) ?? "255"
  const bits = str(ams.tray_exist_bits)
  const exist = bits === undefined ? undefined : Number.parseInt(bits, 16) || 0
  const out: Slot[] = []
  for (const unit of list(ams.ams).filter(isRecord)) {
    const a = Number(unit.id ?? 0)
    for (const t of list(unit.tray).filter(isRecord)) {
      const tray = a * 4 + Number(t.id ?? 0)
      if (Number.isFinite(tray)) {
        out.push(slotOf(t, tray, now, exist))
      }
    }
  }
  return out
}

const hex8 = (n: number) => (n < 0 ? n + 2 ** 32 : n).toString(16).toUpperCase().padStart(8, "0")

export interface Alert {
  readonly code: string
  readonly text?: string
}

/** HMS codes as 16 hex digits and a print error as 8, as Bambu Studio names them. */
export const errorsOf = (raw: Raw, texts: ReadonlyMap<string, string>): Alert[] => {
  const codes = new Set<string>()
  for (const h of list(raw.hms)) {
    if (isRecord(h)) {
      const attr = num(h.attr)
      const code = num(h.code)
      if (attr !== undefined && code !== undefined) {
        codes.add(hex8(attr - (attr % 256)) + hex8(code))
      }
    }
  }
  const printError = num(raw.print_error)
  if (printError !== undefined && printError !== 0) {
    codes.add(hex8(printError))
  }
  return [...codes].map((code) => {
    const words = texts.get(code)
    return words === undefined ? { code } : { code, text: words }
  })
}

export type Phase =
  | "printing"
  | "preparing"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled"
  | "idle"
  | "offline"

const phaseOf = (state: string, online: boolean, errors: readonly Alert[]): Phase => {
  if (!online) {
    return "offline"
  }
  switch (state) {
    case "RUNNING": {
      return "printing"
    }
    case "PREPARE":
    case "SLICING": {
      return "preparing"
    }
    case "PAUSE": {
      return "paused"
    }
    case "FINISH": {
      return "finished"
    }
    case "FAILED": {
      return errors.some((e) => e.code === CANCELED) ? "cancelled" : "failed"
    }
    default: {
      return "idle"
    }
  }
}

/** A printer as plain facts: the status tool's answer, and the widgets' data. */
export interface View {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly online: boolean
  readonly state: string
  readonly phase: Phase
  readonly stage?: string
  readonly file?: string
  readonly percent: number
  readonly layer: number
  readonly layers: number
  readonly minutesLeft: number
  /** When it'll be done, in ms, while a job runs. */
  readonly endsAt: number | null
  readonly nozzle: number
  readonly nozzleTarget: number
  readonly bed: number
  readonly bedTarget: number
  /** The external spool, when set. */
  readonly spool?: { readonly type: string; readonly color: string }
  readonly slots: readonly Slot[]
  readonly errors: readonly Alert[]
  readonly light?: boolean
  /** The heat it's holding while idle, until `until` (ms). */
  readonly hold?: { readonly nozzle: number; readonly bed?: number; readonly until: number }
}

/** The external spool's record: `vt_tray`, or on H2 and P2S the main extruder's in `vir_slot` (255). */
const extOf = (raw: Raw): Raw => {
  if (isRecord(raw.vt_tray)) {
    return raw.vt_tray
  }
  const virtual = list(raw.vir_slot).filter(isRecord)
  return virtual.find((v) => String(v.id) === "255") ?? virtual[0] ?? {}
}

const spoolOf = (raw: Raw) => {
  const vt = extOf(raw)
  const type = text(vt.tray_type)
  return type === undefined ? {} : { spool: { type, color: hex6(str(vt.tray_color)) ?? "" } }
}

const lightOf = (raw: Raw) => {
  const chamber = list(raw.lights_report)
    .filter(isRecord)
    .find((l) => l.node === "chamber_light")
  return chamber === undefined ? {} : { light: chamber.mode === "on" }
}

const round = (x: unknown) => Math.round(num(x) ?? 0)

export const viewOf = (
  printer: { readonly id: string; readonly name: string; readonly model: string },
  raw: Raw,
  online: boolean,
  texts: ReadonlyMap<string, string>,
  now: number,
): View => {
  const state = str(raw.gcode_state) ?? "UNKNOWN"
  const errors = online ? errorsOf(raw, texts) : []
  const active = online && isActive(state)
  const stg = num(raw.stg_cur)
  const stage = active && stg !== undefined ? STAGES[stg] : undefined
  const file = text(raw.subtask_name)
  const left = active ? (num(raw.mc_remaining_time) ?? 0) : 0
  return {
    id: printer.id,
    name: printer.name,
    model: printer.model,
    online,
    state: online ? state : "OFFLINE",
    phase: phaseOf(state, online, errors),
    ...(stage === undefined ? {} : { stage }),
    ...(file === undefined ? {} : { file }),
    percent: num(raw.mc_percent) ?? 0,
    layer: num(raw.layer_num) ?? 0,
    layers: num(raw.total_layer_num) ?? 0,
    minutesLeft: left,
    endsAt: left > 0 ? now + left * 60_000 : null,
    nozzle: round(raw.nozzle_temper),
    nozzleTarget: round(raw.nozzle_target_temper),
    bed: round(raw.bed_temper),
    bedTarget: round(raw.bed_target_temper),
    ...spoolOf(raw),
    slots: slotsOf(raw),
    errors,
    ...lightOf(raw),
  }
}
