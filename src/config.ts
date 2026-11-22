// The printers the user set up: each is ID.env in the `bambu` CLI's folder (~/.config/bambu, or
// $PRINTERS_CONFIG), with BAMBU_HOST, BAMBU_SERIAL and BAMBU_ACCESS_CODE, and NAME for what to call
// it. Read fresh on every connect: the CLI rewrites the host when
// DHCP moves a printer. The access code stays in this process; it goes nowhere but the printer.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const on = (name: string) =>
  ["1", "on", "true", "yes"].includes((process.env[name] ?? "").toLowerCase())
/** Two simulated printers instead of the real ones; they take every command. */
export const SIM = on("PRINTERS_SIM")
/** Commands to the real printers: off unless asked for. */
export const COMMANDS = SIM || on("PRINTERS_COMMANDS")

export const CONFIG_DIR = process.env.PRINTERS_CONFIG ?? path.join(homedir(), ".config", "bambu")

const MODELS: Record<string, string> = {
  "01S": "P1P",
  "01P": "P1S",
  "00M": "X1C",
  "039": "A1",
  "030": "A1 mini",
}

export interface Connection {
  readonly host: string
  readonly serial: string
  readonly accessCode: string
}

export interface Printer {
  /** The CLI's name: p1p, p1p-2, p1s. */
  readonly id: string
  readonly name: string
  readonly model: string
  /** Another job tracker can own completion/failure events for this printer. */
  readonly jobOutcomes: boolean
}

/** KEY=VALUE lines, skipping # comments, like the CLI's read_env. */
const parseEnv = (text: string) => {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) {
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
  }
  return out
}

export const readConnection = (id: string): Connection => {
  const env = parseEnv(readFileSync(path.join(CONFIG_DIR, `${id}.env`), "utf-8"))
  const host = env.BAMBU_HOST ?? ""
  const serial = env.BAMBU_SERIAL ?? ""
  const accessCode = env.BAMBU_ACCESS_CODE ?? ""
  if (host === "" || serial === "" || accessCode === "") {
    throw new Error(`${id}.env needs BAMBU_HOST, BAMBU_SERIAL and BAMBU_ACCESS_CODE`)
  }
  return { host, serial, accessCode }
}

/** The printers set up in the CLI's folder, by id. */
export const configured = (): Printer[] => {
  if (!existsSync(CONFIG_DIR)) {
    return []
  }
  return readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(".env"))
    .map((f) => f.slice(0, -4))
    .toSorted()
    .flatMap((id): Printer[] => {
      try {
        const c = readConnection(id)
        const env = parseEnv(readFileSync(path.join(CONFIG_DIR, `${id}.env`), "utf-8"))
        const name = env.NAME ?? ""
        return [
          {
            id,
            name: name === "" ? id : name,
            model: MODELS[c.serial.slice(0, 3)] ?? "Bambu",
            jobOutcomes: !["off", "false", "0"].includes((env.JOB_OUTCOMES ?? "").toLowerCase()),
          },
        ]
      } catch {
        return []
      }
    })
}

/** Sets what a printer is called: NAME in its env file, its other lines as they were. */
export const writeName = (id: string, name: string) => {
  const file = path.join(CONFIG_DIR, `${id}.env`)
  const lines = readFileSync(file, "utf-8").replace(/\n$/u, "").split("\n")
  const at = lines.findIndex((l) => /^\s*NAME\s*=/u.test(l))
  if (at === -1) {
    lines.push(`NAME=${name}`)
  } else {
    lines[at] = `NAME=${name}`
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
