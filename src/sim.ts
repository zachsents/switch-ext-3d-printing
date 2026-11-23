// A simulated P1P and P1S, for exercising the command tools without hardware: they take the same
// MQTT requests (pushall, pause, resume, stop, ams_filament_setting, project_file, ledctrl,
// print_speed, gcode_line) and answer with
// the same replies and status pushes. A plate on the simulated card prints in about 30 s; one whose
// name has "runout" in it runs out of filament halfway.
import { copyFileSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Printer } from "./config.ts"
import type { Eye } from "./camera.ts"
import type { Card, CardFile } from "./files.ts"
import type { Dial, WireEvents } from "./link.ts"
import type { Raw } from "./state.ts"

export const SIM_PRINTERS: Printer[] = [
  { id: "sim-p1p", name: "Sim P1P", model: "P1P", jobOutcomes: true },
  { id: "sim-p1s", name: "Sim P1S", model: "P1S", jobOutcomes: true },
]

const tray = (id: number, type: string, color: string, idx: string) => ({
  id: String(id),
  tray_type: type,
  tray_color: `${color}FF`,
  tray_info_idx: idx,
  tray_sub_brands: "",
  remain: -1,
  tag_uid: "0000000000000000",
  tray_uuid: "00000000000000000000000000000000",
})

const fresh = (id: string): Raw => ({
  command: "push_status",
  gcode_state: "IDLE",
  stg_cur: -1,
  mc_percent: 0,
  layer_num: 0,
  total_layer_num: 0,
  mc_remaining_time: 0,
  nozzle_temper: 24,
  nozzle_target_temper: 0,
  bed_temper: 22,
  bed_target_temper: 0,
  subtask_name: "",
  print_error: 0,
  hms: [],
  hw_switch_state: 1,
  lights_report: [{ node: "chamber_light", mode: "on" }],
  vt_tray: { id: "254", tray_type: id === "sim-p1p" ? "PLA" : "", tray_color: "000000FF" },
  ams:
    id === "sim-p1s"
      ? {
          ams: [
            {
              id: "0",
              tray: [
                tray(0, "PLA", "FFFFFF", "GFL99"),
                { id: "1" },
                tray(2, "PETG", "1E5AC8", "GFG99"),
                tray(3, "ASA", "000000", "GFB98"),
              ],
            },
          ],
          tray_now: "255",
          tray_exist_bits: "d",
        }
      : {},
})

type Body = Record<string, unknown>

const isBody = (x: unknown): x is Body => typeof x === "object" && x !== null && !Array.isArray(x)
const texts = (x: unknown) => (typeof x === "string" ? x : "")

class SimPrinter {
  raw: Raw
  readonly card = new Map<string, CardFile & { readonly local: string }>()
  private session: WireEvents | undefined
  private tick: ReturnType<typeof setInterval> | undefined

  readonly id: string

  constructor(id: string) {
    this.id = id
    this.raw = fresh(id)
  }

  connect(events: WireEvents) {
    this.session = events
    setTimeout(() => {
      events.up()
    }, 50)
  }

  disconnect() {
    this.session = undefined
  }

  private push(delta: Raw) {
    this.raw = { ...this.raw, ...delta }
    const s = this.session
    if (s) {
      setTimeout(() => {
        s.message(JSON.stringify({ print: { command: "push_status", ...delta } }))
      }, 30)
    }
  }

  private reply(section: string, body: Body, ok: boolean, reason?: string) {
    const s = this.session
    if (s) {
      const answer = {
        command: body.command,
        sequence_id: body.sequence_id,
        result: ok ? "success" : "fail",
        ...(reason === undefined ? {} : { reason }),
      }
      setTimeout(() => {
        s.message(JSON.stringify({ [section]: answer }))
      }, 40)
    }
  }

  request(text: string) {
    const json: unknown = JSON.parse(text)
    if (!isBody(json)) {
      return
    }
    const [section, body] = Object.entries(json)[0] ?? []
    if (section === undefined || !isBody(body)) {
      return
    }
    const state = String(this.raw.gcode_state)
    switch (body.command) {
      case "pushall": {
        this.push(this.raw)
        return
      }
      case "pause": {
        if (state !== "RUNNING") {
          this.reply(section, body, false, "not running")
          return
        }
        this.push({ gcode_state: "PAUSE", stg_cur: 16 })
        this.reply(section, body, true)
        return
      }
      case "resume": {
        if (state !== "PAUSE") {
          this.reply(section, body, false, "not paused")
          return
        }
        this.push({ gcode_state: "RUNNING", stg_cur: 0, hw_switch_state: 1 })
        this.reply(section, body, true)
        return
      }
      case "stop": {
        clearInterval(this.tick)
        this.push({
          gcode_state: "FAILED",
          print_error: 50_348_044,
          mc_remaining_time: 0,
          nozzle_target_temper: 0,
          bed_target_temper: 0,
        })
        this.reply(section, body, true)
        return
      }
      case "ams_filament_setting": {
        this.setFilament(body)
        this.reply(section, body, true)
        return
      }
      case "project_file": {
        this.start(section, body)
        return
      }
      case "ledctrl": {
        this.push({ lights_report: [{ node: "chamber_light", mode: body.led_mode }] })
        this.reply(section, body, true)
        return
      }
      case "print_speed": {
        this.push({ spd_lvl: Number(body.param) })
        this.reply(section, body, true)
        return
      }
      case "gcode_line": {
        this.gcode(String(body.param))
        this.reply(section, body, true)
        return
      }
      default: {
        this.reply(section, body, false, "unknown command")
      }
    }
  }

  /** Heater targets (M104, M109, M140) reached at once, and a pull (a long negative E) unloads. */
  private gcode(text: string) {
    const delta: Body = {}
    for (const line of text.split("\n")) {
      const t = /^M1(?<h>04|09|40) S(?<v>\d+)/u.exec(line)?.groups
      if (t?.v !== undefined) {
        const v = Number(t.v)
        if (t.h === "40") {
          delta.bed_target_temper = v
          delta.bed_temper = Math.max(v, 22)
        } else {
          delta.nozzle_target_temper = v
          delta.nozzle_temper = Math.max(v, 24)
        }
      }
      if (/^G1 E-(?<mm>\d+)/u.test(line) && Number(/E-(?<mm>\d+)/u.exec(line)?.groups?.mm) >= 50) {
        delta.hw_switch_state = 0
      }
    }
    this.push(delta)
  }

  private setFilament(body: Body) {
    const setting = {
      tray_type: body.tray_type,
      tray_color: body.tray_color,
      tray_info_idx: body.tray_info_idx,
      nozzle_temp_min: String(body.nozzle_temp_min),
      nozzle_temp_max: String(body.nozzle_temp_max),
    }
    if (body.ams_id === 255) {
      this.push({ vt_tray: { id: "254", ...setting } })
      return
    }
    const ams = isBody(this.raw.ams) ? this.raw.ams : {}
    const units = (Array.isArray(ams.ams) ? ams.ams : []).filter(isBody).map((u) =>
      Number(u.id) === body.ams_id
        ? {
            ...u,
            tray: (Array.isArray(u.tray) ? u.tray : [])
              .filter(isBody)
              .map((t) => (Number(t.id) === body.tray_id ? { ...t, ...setting } : t)),
          }
        : u,
    )
    this.push({ ams: { ...ams, ams: units } })
  }

  private start(section: string, body: Body) {
    const state = String(this.raw.gcode_state)
    const name = texts(body.url).replace("ftp:///", "")
    if (state === "PREPARE" || state === "RUNNING" || state === "PAUSE") {
      this.reply(section, body, false, "busy")
      return
    }
    if (!this.card.has(name)) {
      this.reply(section, body, false, "no such file")
      return
    }
    this.reply(section, body, true)
    const runsOut = name.includes("runout")
    const layers = 20
    this.push({
      gcode_state: "PREPARE",
      stg_cur: 2,
      subtask_name: texts(body.subtask_name),
      print_error: 0,
      mc_percent: 0,
      layer_num: 0,
      total_layer_num: layers,
      mc_remaining_time: 1,
      nozzle_target_temper: 220,
      bed_target_temper: 65,
    })
    let prepared = 0
    let ranOut = false
    clearInterval(this.tick)
    this.tick = setInterval(() => {
      const now = String(this.raw.gcode_state)
      if (now === "PREPARE") {
        prepared += 1
        this.push({ nozzle_temper: 120 + prepared * 30, bed_temper: 40 + prepared * 8 })
        if (prepared >= 3) {
          this.push({ gcode_state: "RUNNING", stg_cur: 0, nozzle_temper: 220, bed_temper: 65 })
        }
        return
      }
      if (now !== "RUNNING") {
        return
      }
      const percent = Math.min(100, Number(this.raw.mc_percent) + 4)
      if (runsOut && percent >= 50 && !ranOut) {
        ranOut = true
        this.push({ gcode_state: "PAUSE", stg_cur: 6, hw_switch_state: 0, mc_percent: percent })
        return
      }
      if (percent >= 100) {
        clearInterval(this.tick)
        this.push({
          gcode_state: "FINISH",
          mc_percent: 100,
          layer_num: layers,
          mc_remaining_time: 0,
          nozzle_target_temper: 0,
          bed_target_temper: 0,
          stg_cur: -1,
        })
        return
      }
      this.push({
        mc_percent: percent,
        layer_num: Math.round((percent / 100) * layers),
        mc_remaining_time: Math.max(1, Math.round((100 - percent) / 8)),
      })
    }, 1000)
  }
}

const printers = new Map(SIM_PRINTERS.map((p) => [p.id, new SimPrinter(p.id)]))
const sim = (id: string) => {
  const p = printers.get(id)
  if (!p) {
    throw new Error(`No simulated printer ${id}`)
  }
  return p
}

export const simDial: Dial = (id, events) => {
  const p = sim(id)
  p.connect(events)
  return {
    publish: (payload) => {
      setTimeout(() => {
        p.request(payload)
      }, 20)
      return true
    },
    close: () => {
      p.disconnect()
    },
  }
}

/** A plain grey 64x36 picture, about once a second, so recording runs as it does on a printer. */
const GREY = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiaKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA/9k=",
  "base64",
)

export const simEye: Eye = (_id, signal, onFrame) => {
  const tick = setInterval(() => {
    onFrame(GREY)
  }, 1000)
  signal.addEventListener("abort", () => {
    clearInterval(tick)
  })
}

const cardDir = mkdtempSync(path.join(tmpdir(), "printers-sim-"))

export const simCard: Card = {
  list: async (id, folder = "/") =>
    await Promise.resolve(
      folder === "/" ? [...sim(id).card.values()].map(({ local: _, ...f }) => f) : [],
    ),
  upload: async (id, local, name) => {
    const copy = path.join(cardDir, `${id}-${name}`)
    copyFileSync(local, copy)
    sim(id).card.set(name, { name, size: statSync(copy).size, at: Date.now(), local: copy })
    await Promise.resolve()
  },
  download: async (id, remote) => {
    await Promise.reject(new Error(`${id} has no ${remote}`))
  },
}
