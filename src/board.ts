// A printer's widget as Switch's house components draw it: its live camera with its line laid on it
// (its mark, name, where it's at, time left), and under the picture a Pick per AMS slot and the
// external spool, each setting what that slot holds with set_filament.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Option, Schema } from "effect"

import type { View } from "./state.ts"

/** Types every swap offers, then those on hand. */
const TYPES = ["PLA", "PETG", "ASA", "ABS", "TPU"]

/** Colors every swap offers, after those on hand. */
const PALETTE = [
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
]

/** A filament on hand, as the user's shelf says it: what a swap offers first. */
export interface Stocked {
  readonly type: string
  /** RRGGBB. */
  readonly color: string
}

/** What's on hand, kept in the extension's folder (stock.json) by the stock tool. */
const STOCK = path.resolve("stock.json")

const decodeStock = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ type: Schema.String, color: Schema.String }))),
)

export const readStock = (file = STOCK): readonly Stocked[] =>
  existsSync(file) ? decodeStock(readFileSync(file, "utf-8")).pipe(Option.getOrElse(() => [])) : []

export const writeStock = (stock: readonly Stocked[], file = STOCK) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(stock))
  renameSync(`${file}.tmp`, file)
}

const unique = (xs: readonly string[]) => [...new Set(xs)]

/**
 * What a swap offers, as the Pick's groups: the types and colors on hand first, then the usual
 * ones, and any other color as RRGGBB (`custom`).
 */
export const swapOf = (stock: readonly Stocked[]) => [
  { key: "type", choices: unique([...stock.map((x) => x.type.toUpperCase()), ...TYPES]) },
  {
    key: "color",
    swatches: true,
    custom: true,
    choices: unique([...stock.map((x) => x.color.toUpperCase()), ...PALETTE]),
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

/** Each AMS slot, then the external spool: the slot's name and what it holds ("A1 PLA"). */
export const cellsFor = (v: View): Cell[] => [
  ...v.slots.map((s): Cell => ({
    label: s.type === undefined ? s.slot : `${s.slot} ${s.type}`,
    swatch: s.color ?? "",
    strong: s.active,
    title: s.slot,
    current: { type: s.type ?? "PLA", color: s.color ?? "FFFFFF", brand: brand(s.brand) },
    args: { printer: v.id, slot: s.slot },
  })),
  {
    label: v.spool ? `Ext ${v.spool.type}` : "Ext",
    swatch: v.spool?.color ?? "",
    strong: false,
    title: "Ext",
    current: {
      type: v.spool?.type ?? "PLA",
      color: v.spool?.color ?? "FFFFFF",
      brand: "Generic",
    },
    args: { printer: v.id, slot: "ext" },
  },
]

/** A time of day: "12:23 AM". */
const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

/** Where it's at, as its plate says it: "Printing 43%", "Done 12:23 AM", "Idle" (time left is the countdown). */
const stateOf = (v: View, doneAt: number | null) => {
  switch (v.phase) {
    case "printing": {
      return `Printing ${v.percent}%`
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
    cells: cellsFor(v),
  }
}
