// Slicing and the rest of a print's life, through the `bambu` CLI the user installs (on PATH, or
// $PRINTERS_BAMBU): slicing with its presets, the pre-print check, the AMS plan, the purge after a
// spool change, the timelapse recorder. And general printability rules.
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"

import { tool } from "switch-ext-kit"
import { COMMANDS } from "./config.ts"

export const CLI = process.env.PRINTERS_BAMBU ?? "bambu"

const RULES = path.join(import.meta.dir, "rules.md")

/** Runs the CLI; its last lines, or an error with its last line when it fails. */
export const bambu = async (args: readonly string[], ms: number): Promise<string[]> => {
  const proc = Bun.spawn([CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => {
    proc.kill()
  }, ms)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const said = `${out}\n${err}`
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")
  if (code !== 0) {
    throw new Error(said.slice(-12).join("\n") || `bambu ${args[0] ?? ""} exited ${code}`)
  }
  return said
}

const run = (args: readonly string[], ms: number) =>
  Effect.tryPromise({
    try: async () => {
      const said = await bambu(args, ms)
      return { said: said.slice(-60) }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const MINUTE = 60_000

/** A flag per value: --color A --color B. */
const each = (flag: string, values: readonly string[] | undefined) =>
  (values ?? []).flatMap((v) => [flag, v])

const slice = tool(
  "slice",
  {
    description:
      "Slice STLs onto one plate (.gcode.3mf, plus a top-down .png) with the CLI's presets, then run the pre-print check. Parts: 'part.stl', 'part.stl:3' for copies, 'part.stl@2' on filament 2, 'base.stl+logo.stl@2' for one object of two parts. filament: pla, petg, tpu, tpu95, tpu90, tpu85, abs, asa or an exact preset, in filament order; color: RRGGBB in filament order. Multi-filament plates are made for the P1S. Read the summary (time, filament_g, objects, bed_C) and every check WARNING before sending.",
    input: Schema.Struct({
      output: Schema.String,
      parts: Schema.Array(Schema.String),
      filament: Schema.optionalKey(Schema.Array(Schema.String)),
      color: Schema.optionalKey(Schema.Array(Schema.String)),
      machine: Schema.optionalKey(Schema.Literals(["p1p", "p1s"])),
      supports: Schema.optionalKey(Schema.Literals(["bed", "everywhere"])),
      brim: Schema.optionalKey(Schema.Finite),
      layer: Schema.optionalKey(Schema.Finite),
      infill: Schema.optionalKey(Schema.Finite),
      walls: Schema.optionalKey(Schema.Finite),
      /** Round or display parts where the surface is the product: 0.16 layers, back seam, slower walls. */
      cosmetic: Schema.optionalKey(Schema.Boolean),
      /** Bambu's full start routine (purge): after a jam, a swap or a failed first layer. */
      fullStart: Schema.optionalKey(Schema.Boolean),
      /** Heat soak minutes (ASA/ABS warp), as soak adds. */
      soak: Schema.optionalKey(Schema.Finite),
      supportFilament: Schema.optionalKey(Schema.Finite),
      supportInterfaceFilament: Schema.optionalKey(Schema.Finite),
      /** Raw process (set) and filament (fset) overrides, KEY=VALUE. */
      set: Schema.optionalKey(Schema.Array(Schema.String)),
      fset: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  },
  (input) => {
    const args = [
      "slice",
      input.output,
      ...input.parts,
      ...each("--filament", input.filament),
      ...each("--color", input.color),
      ...(input.machine === undefined ? [] : ["--machine", input.machine]),
      ...(input.supports === undefined ? [] : ["--supports", input.supports]),
      ...(input.brim === undefined ? [] : ["--brim", String(input.brim)]),
      ...(input.layer === undefined ? [] : ["--layer", String(input.layer)]),
      ...(input.infill === undefined ? [] : ["--infill", String(input.infill)]),
      ...(input.walls === undefined ? [] : ["--walls", String(input.walls)]),
      ...(input.cosmetic === true ? ["--cosmetic"] : []),
      ...(input.fullStart === true ? ["--full-start"] : []),
      ...(input.soak === undefined ? [] : ["--soak", String(Math.round(input.soak))]),
      ...(input.supportFilament === undefined
        ? []
        : ["--support-filament", String(input.supportFilament)]),
      ...(input.supportInterfaceFilament === undefined
        ? []
        : ["--support-interface-filament", String(input.supportInterfaceFilament)]),
      ...each("--set", input.set),
      ...each("--fset", input.fset),
    ]
    return run(args, 20 * MINUTE)
  },
)

const plate = tool(
  "plate",
  {
    description:
      "A sliced plate's summary: print time, filament grams, bed temperature, objects and plates (only plate 1 prints), and whether it fits the bed. Writes its top-down .png beside it.",
    readOnly: true,
    input: Schema.Struct({ file: Schema.String }),
  },
  (input) => run(["info", input.file], 5 * MINUTE),
)

const check = tool(
  "check",
  {
    description:
      "The pre-print check of a sliced plate: floating islands, thin trunks, brims, support pads, first-layer temperatures. It fails on any ERROR; print runs it too and refuses on errors.",
    readOnly: true,
    input: Schema.Struct({ file: Schema.String, maxZ: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    run(
      ["check", input.file, ...(input.maxZ === undefined ? [] : ["--max-z", String(input.maxZ)])],
      5 * MINUTE,
    ),
)

const SOAKED = /-soak\d+$/u

const soak = tool(
  "soak",
  {
    description:
      "Give a sliced plate a bed heat soak, for ASA and ABS warp: the bed holds its first-layer temperature `minutes` (1-120; 0 takes a soak out) right after it heats, before leveling and the first layer. Writes a copy (`out`, default <name>-soak<minutes>.gcode.3mf beside it) with its checksum and print time counting the soak, then checks it. slice's soak does the same while slicing.",
    input: Schema.Struct({
      file: Schema.String,
      minutes: Schema.Finite,
      out: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* soaking() {
      const minutes = Math.round(input.minutes)
      if (minutes < 0 || minutes > 120) {
        return yield* Effect.fail(new Error("A soak is 0 to 120 minutes"))
      }
      if (!input.file.endsWith(".gcode.3mf")) {
        return yield* Effect.fail(new Error(`${input.file} isn't a sliced plate (.gcode.3mf)`))
      }
      const stem = input.file.slice(0, -".gcode.3mf".length).replace(SOAKED, "")
      const out = input.out ?? `${stem}${minutes > 0 ? `-soak${minutes}` : ""}.gcode.3mf`
      const soaked = yield* run(["soak", input.file, String(minutes), "--out", out], 10 * MINUTE)
      const checked = yield* run(["check", out], 5 * MINUTE).pipe(
        Effect.catch((error: Error) => Effect.succeed({ said: error.message.split("\n") })),
      )
      return { file: out, said: soaked.said, check: checked.said }
    }),
)

const inspect = tool(
  "inspect",
  {
    description:
      "Compare an STL's six bed orientations (area on the bed, overhangs by steepness) and render an overhang sheet; `write` saves the part turned that way, on z = 0, ready to slice. Look at the sheet: a small flat ceiling can span 2 cm. Others' STLs are never print-ready as uploaded.",
    readOnly: true,
    input: Schema.Struct({
      stl: Schema.String,
      down: Schema.optionalKey(Schema.String),
      sheet: Schema.optionalKey(Schema.String),
      write: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    run(
      [
        "inspect",
        input.stl,
        ...(input.down === undefined ? [] : ["--down", input.down]),
        ...(input.sheet === undefined ? [] : ["--out", input.sheet]),
        ...(input.write === undefined ? [] : ["--write", input.write]),
      ],
      5 * MINUTE,
    ),
)

const timelapse = tool(
  "timelapse",
  {
    description:
      "Every print records a camera timelapse. list: what's recording, unfinished frame folders and the newest videos (mp4 plus a .jpg preview). latest: the running recorder's newest frame for a printer. fetch: the printer's own timelapse from its card (all: every one). start/stop: a recorder by hand. encode: a dead recorder's frames folder into the video.",
    input: Schema.Struct({
      action: Schema.Literals(["list", "latest", "fetch", "start", "stop", "encode"]),
      printer: Schema.optionalKey(Schema.String),
      all: Schema.optionalKey(Schema.Boolean),
      frames: Schema.optionalKey(Schema.String),
    }),
  },
  (input) => {
    const on = input.printer === undefined ? [] : ["-p", input.printer]
    if (input.action === "encode") {
      return input.frames === undefined
        ? Effect.fail(new Error("encode needs frames"))
        : run(["timelapse", "encode", input.frames], 30 * MINUTE)
    }
    return run(
      ["timelapse", input.action, ...on, ...(input.all === true ? ["--all"] : [])],
      10 * MINUTE,
    )
  },
)

const discover = tool(
  "discover",
  {
    description:
      "Listen for Bambu printers' LAN broadcasts: IP, serial, model, firmware, and which configured printer each is. Adding one is the user's (`bambu add`, the access code at a hidden prompt).",
    readOnly: true,
  },
  () => run(["discover"], MINUTE),
)

/** The CLI's own printer commands, only when commands are on. */
const device = (args: readonly string[]) =>
  COMMANDS ? run(args, 2 * MINUTE) : Effect.fail(new Error("Commands are off"))

const speed = tool(
  "speed",
  {
    description:
      "The running job's speed: silent (about half speed, much quieter, for overnight near sleepers), standard, sport, ludicrous.",
    input: Schema.Struct({
      printer: Schema.String,
      level: Schema.Literals(["silent", "standard", "sport", "ludicrous"]),
    }),
  },
  (input) => device(["-p", input.printer, "speed", input.level]),
)

const light = tool(
  "light",
  {
    description: "The chamber light. On for prints after dark, so the camera and timelapse see.",
    input: Schema.Struct({ printer: Schema.String, on: Schema.Boolean }),
  },
  (input) => device(["-p", input.printer, "light", input.on ? "on" : "off"]),
)

const extrude = tool(
  "extrude",
  {
    description: "Push filament through a hot nozzle (190 °C or more), in mm.",
    input: Schema.Struct({ printer: Schema.String, mm: Schema.Finite }),
  },
  (input) => device(["-p", input.printer, "extrude", String(input.mm)]),
)

const SECTIONS = {
  checklist: "Pre-print",
  failures: "Failure",
  lessons: "Lessons",
  design: "Designing",
}

const rules = tool(
  "rules",
  {
    description:
      "General printing rules, learned from failed prints. design: for parts being designed to print (fillets, teardrop holes, split faces, snap hooks, clearances). checklist, failures, lessons: for slicing and sending. Read design before designing anything that will be 3D printed.",
    readOnly: true,
    input: Schema.Struct({
      section: Schema.optionalKey(Schema.Literals(["design", "checklist", "failures", "lessons"])),
    }),
  },
  (input) =>
    Effect.sync(() => {
      const all = readFileSync(RULES, "utf-8")
      if (input.section === undefined) {
        return all
      }
      const start = SECTIONS[input.section]
      const parts = all.split(/^## /mu)
      return `## ${parts.find((p) => p.startsWith(start)) ?? ""}`
    }),
)

export const makingTools = [
  slice,
  plate,
  check,
  soak,
  inspect,
  timelapse,
  discover,
  speed,
  light,
  extrude,
  rules,
]
