// A printer's line as Switch's house components draw it: a Row (its mark, name, what's under
// it, progress and time left) over a Pick per AMS slot or the external spool, each swapping its
// filament with set_filament.
import type { View } from "./state.ts"

/** What a swap offers, as the Pick's groups. */
export const SWAP = [
  { key: "type", choices: ["PLA", "PETG", "ASA", "ABS", "TPU"] },
  {
    key: "color",
    swatches: true,
    choices: [
      "000000",
      "FFFFFF",
      "8E8E8E",
      "C0C0C0",
      "C81E23",
      "F0781E",
      "F0D228",
      "289646",
      "009696",
      "1E5AC8",
      "14235A",
      "783CAA",
      "F08CB4",
      "6E4628",
      "E1CDA5",
      "C8A03C",
    ],
  },
  { key: "brand", choices: ["Generic", "Bambu"] },
]

export interface Cell {
  readonly label: string
  readonly swatch: string
  readonly strong: boolean
  readonly title: string
  readonly current: { readonly type: string; readonly color: string; readonly brand: string }
  readonly args: { readonly printer: string; readonly slot: string }
}

export interface Line {
  readonly id: string
  readonly label: string
  readonly mark: string
  readonly detail: string
  readonly alert: boolean
  readonly values: readonly string[]
  readonly progress: number | null
  readonly endsAt: number | null
  readonly cells: readonly Cell[]
}

const ACTIVE = new Set(["printing", "preparing", "paused"])

const markOf = (v: View) => {
  if (v.phase === "printing" || v.phase === "preparing") {
    return "running"
  }
  // Paused waits on the user; finished is idle, as Bambu reports it until the next job.
  if (v.phase === "paused") {
    return "needsYou"
  }
  if (v.phase === "failed" || v.phase === "offline") {
    return "stop"
  }
  return v.errors.length > 0 ? "warn" : ""
}

const brand = (b: string | undefined) => (b === "Bambu" ? "Bambu" : "Generic")

const cellsOf = (v: View): Cell[] => {
  const slots = v.slots.map((s): Cell => ({
    label: s.type ?? s.slot,
    swatch: s.loaded ? (s.color ?? "") : "",
    strong: s.active,
    title: s.slot,
    current: { type: s.type ?? "PLA", color: s.color ?? "FFFFFF", brand: brand(s.brand) },
    args: { printer: v.id, slot: s.slot },
  }))
  if (slots.length > 0) {
    return slots
  }
  return [
    {
      label: v.spool?.type ?? "ext",
      swatch: v.spool?.color ?? "",
      strong: false,
      title: "Spool",
      current: {
        type: v.spool?.type ?? "PLA",
        color: v.spool?.color ?? "FFFFFF",
        brand: "Generic",
      },
      args: { printer: v.id, slot: "ext" },
    },
  ]
}

const two = (n: number) => String(n).padStart(2, "0")

/** Minutes as a clock: "1:12". */
const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${two(minutes % 60)}`

/** A time of day: "12:23 AM". */
const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

/** Where it's at, as its plate says it: "Printing 43% · 1:12 left", "Done 12:23 AM", "Idle". */
const stateOf = (v: View, doneAt: number | null) => {
  switch (v.phase) {
    case "printing": {
      return `Printing ${v.percent}% · ${clock(v.minutesLeft)} left`
    }
    case "preparing": {
      return v.stage ?? "Preparing"
    }
    case "paused": {
      return "Paused"
    }
    case "finished": {
      return doneAt === null ? "Done" : `Done ${timeOf(doneAt)}`
    }
    case "failed": {
      return "Failed"
    }
    case "cancelled": {
      return "Cancelled"
    }
    case "offline": {
      return "Offline"
    }
    case "idle": {
      return "Idle"
    }
    default: {
      return "Idle"
    }
  }
}

/** Its line: its name, and what's wrong, else where it's at (`doneAt`: when its last job ended). */
export const lineOf = (v: View, doneAt: number | null = null): Line => {
  const active = ACTIVE.has(v.phase)
  const wrong = v.errors.map((a) => a.text ?? a.code).find((t) => t !== "")
  const detail = wrong ?? stateOf(v, doneAt)
  return {
    id: v.id,
    label: v.name,
    mark: markOf(v),
    detail,
    alert: wrong !== undefined,
    values: [],
    progress: active ? v.percent : null,
    endsAt: active ? v.endsAt : null,
    cells: cellsOf(v),
  }
}
