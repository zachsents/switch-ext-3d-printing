// The extension's slicing library (lib/bambu.py, a uv script): slicing with Bambu Studio's CLI, the
// pre-print check, print planning, encoding timelapses and listening for printers. It never connects
// to a printer. Its scratch work goes in the extension's folder (work/).
import path from "node:path"

import { CONFIG_DIR } from "./config.ts"

const SCRIPT = path.join(import.meta.dir, "..", "lib", "bambu.py")
export const WORK = path.resolve("work")

const run = async (args: readonly string[], ms: number, stdin?: string) => {
  const proc = Bun.spawn(["uv", "run", "--quiet", "--script", SCRIPT, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PRINTERS_WORK: WORK, PRINTERS_CONFIG: CONFIG_DIR },
  })
  const timer = setTimeout(() => {
    proc.kill()
  }, ms)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { out, err, code }
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")

/** Runs the library; its lines, or an error with its last lines when it fails. */
export const library = async (args: readonly string[], ms: number): Promise<string[]> => {
  const { out, err, code } = await run(args, ms)
  const said = lines(`${out}\n${err}`)
  if (code !== 0) {
    throw new Error(said.slice(-12).join("\n") || `${args[0] ?? ""} exited ${code}`)
  }
  return said
}

/** Runs a command that answers one JSON line on stdout (plan, listen): that line, unparsed. */
export const libraryJson = async (args: readonly string[], ms: number, stdin?: string) => {
  const { out, err } = await run(args, ms, stdin)
  const line = lines(out).at(-1)
  if (line === undefined) {
    throw new Error(lines(err).slice(-12).join("\n") || `${args[0] ?? ""} said nothing`)
  }
  return line
}
