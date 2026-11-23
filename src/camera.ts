// A printer's camera. P1, P2 and A1: TLS on port 6000, an 80-byte login, then length-prefixed
// JPEGs, about one a second, as the `bambu` CLI's grab_frame read it. X1 and H2: RTSPS on port 322,
// pulled a frame at a time (rtsps.ts, rtspsEye). The camera serves one client at a time, and this
// extension is its only one: one stream is held while someone looks, let go LINGER_MS after they
// stop, and held throughout while a timelapse records.
import tls from "node:tls"

import { readConnection } from "./config.ts"
import type { Connection } from "./config.ts"
import { cameraLogin } from "./payloads.ts"
import { PULL_EVERY_MS, pullFrame, RTSPS_MODELS } from "./rtsps.ts"
import type { Spawner } from "./rtsps.ts"

/** Keep a live stream this long after the last look. */
const LINGER_MS = 10_000
/** How long a look waits for a first frame. */
const FIRST_MS = 8000
const MAX_FRAME = 4_000_000

export interface Frame {
  readonly jpeg: Buffer
  readonly at: number
  /** live: from the stream open now; kept: the last one it gave before it closed. */
  readonly source: "live" | "kept"
}

/** Opens a camera stream: frames as they come, `onEnd` once if it closes by itself. `signal` closes it. */
export type Eye = (
  id: string,
  signal: AbortSignal,
  onFrame: (jpeg: Buffer) => void,
  onEnd: (problem: string) => void,
) => void

const isJpeg = (b: Buffer) =>
  b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9

/**
 * The real camera, on the LAN. A P1's camera answers a new connection first with the last frame it
 * encoded before, which can be hours old, so that frame is thrown away and frames start with the next
 * one that differs from it, as the CLI's fresh_frame took them.
 */
export const tlsEye: Eye = (id, signal, onFrame, onEnd) => {
  let stale: Buffer | undefined
  let fresh = false
  let ended = false
  const end = (problem: string) => {
    if (!ended) {
      ended = true
      onEnd(problem)
    }
  }
  let conn: ReturnType<typeof readConnection>
  try {
    conn = readConnection(id)
  } catch (error) {
    end(error instanceof Error ? error.message : String(error))
    return
  }
  const socket = tls.connect({ host: conn.host, port: 6000, rejectUnauthorized: false })
  socket.setTimeout(15_000)
  let buf = Buffer.alloc(0)
  socket.on("secureConnect", () => {
    socket.write(cameraLogin(conn.accessCode))
  })
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 16) {
      const size = buf.readUInt32LE(0)
      if (size > MAX_FRAME) {
        end("Bad camera stream")
        socket.destroy()
        return
      }
      if (buf.length < 16 + size) {
        return
      }
      const jpeg = Buffer.from(buf.subarray(16, 16 + size))
      buf = buf.subarray(16 + size)
      if (!isJpeg(jpeg)) {
        end("Bad camera stream")
        socket.destroy()
        return
      }
      if (stale === undefined) {
        stale = jpeg
      } else if (fresh || !jpeg.equals(stale)) {
        fresh = true
        if (!signal.aborted) {
          onFrame(jpeg)
        }
      }
    }
  })
  socket.on("timeout", () => {
    end("Camera timed out")
    socket.destroy()
  })
  socket.on("error", (error) => {
    end(error.message)
  })
  socket.on("close", () => {
    end("Camera closed")
  })
  signal.addEventListener("abort", () => {
    ended = true
    socket.destroy()
  })
}

/**
 * The camera of an X1 or H2 (rtsps.ts): one-frame ffmpeg pulls, back to back, at most one a
 * PULL_EVERY_MS, while the stream is open. A pull that fails ends the stream, as a dropped socket
 * does; Camera retries it. Every frame comes from a pull started after the stream opened, so none is
 * older than this look.
 */
export const makeRtspsEye =
  (
    options: {
      readonly spawner?: Spawner
      readonly everyMs?: number
      readonly timeoutMs?: number
      readonly read?: (id: string) => Connection
    } = {},
  ): Eye =>
  (id, signal, onFrame, onEnd) => {
    let conn: Connection
    try {
      conn = (options.read ?? readConnection)(id)
    } catch (error) {
      onEnd(error instanceof Error ? error.message : String(error))
      return
    }
    const every = options.everyMs ?? PULL_EVERY_MS
    const fail = (error: unknown) => {
      if (!signal.aborted) {
        onEnd(error instanceof Error ? error.message : String(error))
      }
    }
    // Each pull schedules the next, so a stream held for hours builds no chain.
    const pull = async () => {
      const started = Date.now()
      let jpeg: Buffer
      try {
        jpeg = await pullFrame(conn, signal, {
          ...(options.spawner ? { spawner: options.spawner } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
      } catch (error) {
        fail(error)
        return
      }
      if (signal.aborted) {
        return
      }
      onFrame(jpeg)
      setTimeout(
        () => {
          if (!signal.aborted) {
            void pull()
          }
        },
        Math.max(0, every - (Date.now() - started)),
      )
    }
    void pull()
  }

export const rtspsEye: Eye = makeRtspsEye()

/** The camera a model has: RTSPS for X1 and H2, the JPEG stream on 6000 for the rest. */
export const eyeFor = (model: string): Eye => (RTSPS_MODELS.has(model) ? rtspsEye : tlsEye)

/** After a stream fails, wait this long before opening another. */
const RETRY_MS = 5000

export class Camera {
  latest: Frame | undefined
  problem = ""
  readonly id: string
  private readonly eye: Eye
  private stream: AbortController | undefined
  private lastAsked = 0
  private retryAt = 0
  /** Timelapses recording: the stream stays open while any does. */
  private holds = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private readonly waiting = new Set<() => void>()

  constructor(id: string, eye: Eye) {
    this.id = id
    this.eye = eye
  }

  /** The newest frame for someone looking now. */
  async frame(): Promise<Frame | undefined> {
    this.lastAsked = Date.now()
    this.ensure()
    if (this.stream && this.latest?.source !== "live") {
      await this.next(FIRST_MS)
    }
    return this.latest
  }

  /** Keeps the stream open until `release`, reopening it when it fails. */
  hold() {
    this.holds += 1
    this.ensure()
  }

  release() {
    this.holds = Math.max(0, this.holds - 1)
  }

  stop() {
    this.holds = 0
    this.letGo()
  }

  private ensure() {
    if (!this.stream && Date.now() >= this.retryAt) {
      this.openLive()
    }
    this.ticker ??= setInterval(() => {
      if (this.holds > 0) {
        this.ensure()
      } else if (Date.now() - this.lastAsked > LINGER_MS) {
        this.letGo()
      }
    }, 1000)
  }

  private async next(ms: number) {
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const done = () => {
      clearTimeout(timer)
      this.waiting.delete(done)
      resolve(undefined)
    }
    const timer = setTimeout(done, ms)
    this.waiting.add(done)
    await promise
  }

  private got(jpeg: Buffer) {
    this.latest = { jpeg, at: Date.now(), source: "live" }
    this.problem = ""
    for (const w of this.waiting) {
      w()
    }
  }

  private failed(problem: string) {
    this.problem = problem
    this.retryAt = Date.now() + RETRY_MS
    for (const w of this.waiting) {
      w()
    }
  }

  private openLive() {
    const stop = new AbortController()
    this.stream = stop
    this.eye(
      this.id,
      stop.signal,
      (jpeg) => {
        this.got(jpeg)
      },
      (problem) => {
        this.failed(problem)
        if (this.stream === stop) {
          this.closeStream()
        }
      },
    )
  }

  private closeStream() {
    const s = this.stream
    this.stream = undefined
    s?.abort()
    if (this.latest?.source === "live") {
      this.latest = { ...this.latest, source: "kept" }
    }
  }

  private letGo() {
    clearInterval(this.ticker)
    this.ticker = undefined
    this.closeStream()
  }
}
