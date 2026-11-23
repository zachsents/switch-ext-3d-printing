// The MQTT requests a P1 takes (device/SERIAL/request), as Bambu Studio and the `bambu` CLI sent
// them. Each carries its own sequence_id, which the printer echoes in its reply.

export type Field = string | number | boolean | readonly unknown[]

export interface Request {
  readonly section: "print" | "system" | "pushing"
  readonly body: { readonly sequence_id: string; readonly command: string } & Readonly<
    Record<string, Field>
  >
}

export const encode = ({ section, body }: Request) => JSON.stringify({ [section]: body })

/** Asks for a full report; a P1 otherwise pushes only what changed. Reads, changes nothing. */
export const pushall = (seq: string): Request => ({
  section: "pushing",
  body: { sequence_id: seq, command: "pushall" },
})

export const jobControl = (seq: string, action: "pause" | "resume" | "stop"): Request => ({
  section: "print",
  body: { sequence_id: seq, command: action },
})

/** G-code lines for the printer to run now, as Bambu Studio's console sends them. */
export const gcode = (seq: string, lines: readonly string[]): Request => ({
  section: "print",
  body: { sequence_id: seq, command: "gcode_line", param: `${lines.join("\n")}\n` },
})

/** The nozzle's (M104) and bed's (M140) targets in °C; 0 turns a heater off. */
export const temps = (seq: string, nozzle: number, bed?: number): Request =>
  gcode(seq, [`M104 S${nozzle}`, ...(bed === undefined ? [] : [`M140 S${bed}`])])

/**
 * Unloads the external spool with plain G-code rather than the printer's own routine, which cools
 * the nozzle and parks until the filament is pulled, ignoring heat meanwhile: waits for `temp`,
 * pushes a little to soften the tip, then pulls it up past the gears and the filament sensor,
 * leaving the heaters where they were.
 */
export const unload = (seq: string, temp: number): Request =>
  gcode(seq, [`M109 S${temp}`, "M83", "G1 E5 F300", "G1 E-30 F1800", "G1 E-70 F600"])

export interface Preset {
  /** Bambu Studio's filament id (tray_info_idx): GFL99 for Generic PLA. */
  readonly idx: string
  readonly type: string
  readonly minTemp: number
  readonly maxTemp: number
}

/**
 * What the printer thinks is in an AMS slot (ams 0.., tray 0..3) or on the external spool (ams
 * 255, tray 254), as `bambu spool` sets it. `color` is RRGGBB; the printer wants RRGGBBAA.
 */
export const filamentSetting = (
  seq: string,
  where: { readonly ams: number; readonly tray: number },
  preset: Preset,
  color: string,
): Request => {
  const hex = color.replace(/^#/u, "").toUpperCase()
  return {
    section: "print",
    body: {
      sequence_id: seq,
      command: "ams_filament_setting",
      ams_id: where.ams,
      tray_id: where.tray,
      tray_info_idx: preset.idx,
      tray_type: preset.type,
      tray_color: hex.length === 8 ? hex : `${hex}FF`,
      nozzle_temp_min: preset.minTemp,
      nozzle_temp_max: preset.maxTemp,
    },
  }
}

/** The chamber light, as the CLI's `light` sent it. */
export const ledctrl = (seq: string, on: boolean): Request => ({
  section: "system",
  body: {
    sequence_id: seq,
    command: "ledctrl",
    led_node: "chamber_light",
    led_mode: on ? "on" : "off",
    led_on_time: 500,
    led_off_time: 500,
    loop_times: 0,
    interval_time: 0,
  },
})

/** The printer's own speed modes; silent runs at about half speed and much quieter. */
export const SPEED_LEVELS = { silent: 1, standard: 2, sport: 3, ludicrous: 4 } as const

/** The running job's speed level, as the CLI's `speed`: from the next move until the job ends. */
export const printSpeed = (seq: string, level: keyof typeof SPEED_LEVELS): Request => ({
  section: "print",
  body: { sequence_id: seq, command: "print_speed", param: String(SPEED_LEVELS[level]) },
})

/** Pushes `mm` of filament through a hot nozzle at `speed` mm/min, as the CLI's `extrude`. */
export const extrude = (seq: string, mm: number, speed: number) =>
  gcode(seq, ["M83", `G1 E${mm} F${speed}`])

type Payload = Readonly<Record<string, Field>>

/**
 * A command the library built (a section and its body, its sequence_id "0") with this session's
 * sequence id: plan's project_file and the loaded spool's ams_filament_setting.
 */
export const fromLibrary = (
  seq: string,
  section: Request["section"],
  body: Payload & { readonly command: string },
): Request => ({ section, body: { ...body, sequence_id: seq } })

/**
 * The camera's 80-byte login (TLS on port 6000), like the CLI's grab_frame: four little-endian
 * words (0x40, 0x3000, 0, 0), then the user and the access code, each padded to 32 bytes.
 */
export const cameraLogin = (accessCode: string) => {
  const login = Buffer.alloc(80)
  login.writeUInt32LE(0x40, 0)
  login.writeUInt32LE(0x30_00, 4)
  login.write("bblp", 16, "utf-8")
  login.write(accessCode, 48, 32, "utf-8")
  return login
}
