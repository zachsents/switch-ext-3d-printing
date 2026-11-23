// Whether the printers' sense works: each printer's session and the work done on its reports, read
// into the heartbeat (`printers.heartbeat`). A printer that's off answers nothing, which isn't a
// failure; a session that won't come up for any other reason, or work that throws, is, until it
// works again. Pure, given each printer's standing.
import { Heartbeat } from "./events.ts"

/** Offline less than this is a reconnect, not yet off or failing. */
export const GRACE_MS = 60_000
/** The heartbeat's cadence, from the ticker: it stops if the ticker does. */
export const BEAT_MS = 5 * 60_000
/** Nothing answers at its address: the printer is off (or asleep without its network). */
const OFF = /^No answer$|EHOSTUNREACH|EHOSTDOWN|ETIMEDOUT/u

export interface Standing {
  readonly id: string
  readonly name: string
  readonly online: boolean
  /** Why its last session ended, or "" while one is up. */
  readonly problem: string
  /** How long it has been offline, in ms; 0 while online. */
  readonly downFor: number
  /** Work on its reports that threw, by part, until that part works again. */
  readonly errors: readonly string[]
}

const stateOf = (s: Standing): "online" | "connecting" | "off" | "down" => {
  if (s.online) {
    return "online"
  }
  if (s.downFor < GRACE_MS) {
    return "connecting"
  }
  return OFF.test(s.problem) ? "off" : "down"
}

/** The heartbeat for these printers and what else failed (finding moved printers), with its `failing`. */
export const heartbeat = (printers: readonly Standing[], others: readonly string[]) => {
  const rows = printers.map((s) => ({ ...s, state: stateOf(s) }))
  const failing = [
    ...rows.flatMap((r) => [
      ...(r.state === "down" ? [`${r.name}: ${r.problem || "No full report"}`] : []),
      ...r.errors.map((e) => `${r.name}: ${e}`),
    ]),
    ...others,
  ]
  const counts = new Map<string, number>()
  for (const r of rows) {
    counts.set(r.state, (counts.get(r.state) ?? 0) + 1)
  }
  const tally = [...counts].map(([state, n]) => `${n} ${state}`).join(", ")
  const line = failing.length === 0 ? null : failing.join("; ")
  const draft = Heartbeat.make({
    entity: "sense:printers",
    summary: line ?? (tally || "No printers"),
    facts: {
      failing: line,
      printers: rows.map((r) => ({
        printer: r.id,
        name: r.name,
        state: r.state,
        ...(r.problem === "" || r.online ? {} : { problem: r.problem }),
        ...(r.errors.length === 0 ? {} : { errors: r.errors }),
      })),
    },
  })
  return { draft, failing: line }
}
