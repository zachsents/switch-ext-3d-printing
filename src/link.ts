// One printer's MQTT session (TLS on 8883, user bblp, the access code as the password), held for as
// long as the extension runs, beside any other client's. It reconnects with backoff, asks for a
// full report when the printer goes quiet, and drops a session gone silent. The wire is pluggable,
// so the simulator speaks the same requests and reports.
import mqtt from "mqtt"

import { readConnection } from "./config.ts"
import { encode, pushall } from "./payloads.ts"
import type { Request } from "./payloads.ts"
import { isFull, mergePush, parseMessage } from "./state.ts"
import type { Message, Raw } from "./state.ts"

/** Ask for a full report after this long without one... */
const QUIET_MS = 30_000
/** ...and count the printer as gone, and reconnect, after this long. */
const SILENT_MS = 75_000
const BACKOFF_MS = [2000, 5000, 10_000, 30_000, 60_000]
const REPLY_MS = 5000

export interface WireEvents {
  readonly up: () => void
  readonly message: (text: string) => void
  readonly down: (problem: string) => void
}

/** One session to a printer. `down` fires once when it ends, and the link dials again. */
export interface Wire {
  readonly publish: (payload: string) => boolean
  readonly close: () => void
}

export type Dial = (id: string, events: WireEvents) => Wire

const closeNothing = () => {
  // Nothing was opened.
}

/** The real printer, over MQTT on the LAN. */
export const mqttDial: Dial = (id, events) => {
  let conn: ReturnType<typeof readConnection>
  try {
    conn = readConnection(id)
  } catch (error) {
    events.down(error instanceof Error ? error.message : String(error))
    return { publish: () => false, close: closeNothing }
  }
  let ended = false
  let connected = false
  const end = (problem: string) => {
    if (!ended) {
      ended = true
      events.down(problem)
    }
  }
  const client = mqtt.connect(`mqtts://${conn.host}:8883`, {
    username: "bblp",
    password: conn.accessCode,
    rejectUnauthorized: false,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    keepalive: 30,
    clientId: `switch-printers-${id}-${Math.random().toString(36).slice(2, 8)}`,
  })
  client.on("connect", () => {
    connected = true
    client.subscribe(`device/${conn.serial}/report`)
    events.up()
  })
  client.on("message", (_topic, payload) => {
    events.message(payload.toString())
  })
  client.on("error", (error) => {
    end(`Can't connect: ${error.message}`)
  })
  client.on("close", () => {
    const was = connected
    connected = false
    end(was ? "Connection lost" : "No answer")
    client.removeAllListeners()
    client.end(true)
  })
  return {
    publish: (payload) => {
      if (!connected) {
        return false
      }
      client.publish(`device/${conn.serial}/request`, payload)
      return true
    },
    close: () => {
      ended = true
      client.removeAllListeners()
      client.end(true)
    },
  }
}

export interface Reply {
  readonly ok: boolean
  readonly reason?: string
}

export class Link {
  /** The merged reports of this session; empty while disconnected. */
  raw: Raw = {}
  problem = ""
  seenAt = 0
  private wire: Wire | undefined
  private connected = false
  private failures = 0
  private lastPushall = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private sequence = 30_000 + Math.floor(Math.random() * 10_000)
  private readonly listeners = new Set<() => void>()
  private readonly replies = new Map<string, (reply: Reply) => void>()
  private readonly watchdog: ReturnType<typeof setInterval>

  readonly id: string
  /** Whether anything but a status request may be sent. */
  readonly commands: boolean
  private readonly dial: Dial

  constructor(id: string, dial: Dial, commands: boolean) {
    this.id = id
    this.dial = dial
    this.commands = commands
    this.watchdog = setInterval(() => {
      this.check()
    }, 5000)
    this.open()
  }

  /** Connected, a full report arrived on this session, and it reported lately. */
  online() {
    return this.connected && isFull(this.raw) && Date.now() - this.seenAt < SILENT_MS
  }

  nextSeq() {
    this.sequence += 1
    return String(this.sequence)
  }

  /** Publishes a request and waits a few seconds for its reply; undefined when none came. */
  async send(request: Request): Promise<Reply | undefined> {
    if (request.section !== "pushing" && !this.commands) {
      throw new Error("Commands are off")
    }
    if (this.wire?.publish(encode(request)) !== true) {
      throw new Error("Not connected")
    }
    const seq = request.body.sequence_id
    const { promise, resolve } = Promise.withResolvers<Reply | undefined>()
    const timer = setTimeout(() => {
      this.replies.delete(seq)
      resolve(undefined)
    }, REPLY_MS)
    this.replies.set(seq, (reply) => {
      clearTimeout(timer)
      this.replies.delete(seq)
      resolve(reply)
    })
    return await promise
  }

  /** True once `test` holds for the state, false after `ms`. */
  async waitFor(test: (raw: Raw) => boolean, ms: number): Promise<boolean> {
    if (test(this.raw)) {
      return true
    }
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const check = () => {
      if (test(this.raw)) {
        clearTimeout(timer)
        this.listeners.delete(check)
        resolve(true)
      }
    }
    const timer = setTimeout(() => {
      this.listeners.delete(check)
      resolve(false)
    }, ms)
    this.listeners.add(check)
    return await promise
  }

  /** Called after every report and connection change. */
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close() {
    this.closed = true
    clearInterval(this.watchdog)
    clearTimeout(this.retry)
    this.wire?.close()
    this.wire = undefined
    this.connected = false
  }

  private notify() {
    for (const l of this.listeners) {
      l()
    }
  }

  private pushall() {
    this.lastPushall = Date.now()
    this.wire?.publish(encode(pushall(this.nextSeq())))
  }

  private open() {
    const session: { wire?: Wire; dead: boolean } = { dead: false }
    const mine = () => !session.dead && session.wire !== undefined && this.wire === session.wire
    session.wire = this.dial(this.id, {
      up: () => {
        if (!mine()) {
          return
        }
        this.connected = true
        this.failures = 0
        this.problem = ""
        this.seenAt = Date.now()
        this.pushall()
        this.notify()
      },
      message: (text) => {
        if (!mine()) {
          return
        }
        const m: Message = parseMessage(text)
        this.seenAt = Date.now()
        if (m.push) {
          this.raw = mergePush(this.raw, m.push)
        }
        if (m.reply) {
          this.replies.get(m.reply.seq)?.(m.reply)
        }
        this.notify()
      },
      down: (problem) => {
        if (session.dead) {
          return
        }
        session.dead = true
        if (session.wire !== undefined && this.wire !== session.wire) {
          return
        }
        this.problem = problem
        this.connected = false
        this.wire = undefined
        // The next session starts from its own full report.
        this.raw = {}
        this.notify()
        this.redial()
      },
    })
    if (!session.dead) {
      this.wire = session.wire
    }
  }

  private redial() {
    if (this.closed || this.retry) {
      return
    }
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)] ?? 60_000
    this.failures += 1
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.open()
    }, wait)
  }

  private check() {
    if (!this.wire || !this.connected) {
      return
    }
    const quiet = Date.now() - this.seenAt
    if (quiet > SILENT_MS) {
      this.problem = "Stopped reporting"
      const { wire } = this
      this.wire = undefined
      this.connected = false
      this.raw = {}
      wire.close()
      this.notify()
      this.redial()
    } else if (quiet > QUIET_MS && Date.now() - this.lastPushall > QUIET_MS) {
      this.pushall()
    }
  }
}
