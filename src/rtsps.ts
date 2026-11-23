// The camera of an X1 or H2 printer: RTSP over TLS on port 322 (self-signed), H.264 at
// /streaming/live/1, user bblp, the access code as password. Port 322 opens only while "LAN Only
// Liveview" is on in the printer's settings. These printers don't serve the P1/A1 JPEG stream on
// port 6000: they answer its login with a short reply and close.
//
// Each frame is one ffmpeg pull: connect, decode the first picture, write it as one JPEG, exit. The
// URL with the access code goes to ffmpeg on stdin as a one-entry ffconcat list, so it's never in a
// process listing, and ffmpeg's error output is scrubbed of it before it's kept or logged.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

import type { Connection } from "./config.ts"

export const RTSPS_PORT = 322
/** One pull gives up after this long. */
export const PULL_MS = 15_000
/** Pulls start at most this often. */
export const PULL_EVERY_MS = 1000
const MAX_FRAME = 4_000_000

/** Models whose camera is RTSPS on 322, not the JPEG stream on 6000. */
export const RTSPS_MODELS: ReadonlySet<string> = new Set(["X1", "X1C", "X1E", "H2C", "H2D", "H2S"])

export const ffmpegPath = () =>
  Bun.which("ffmpeg") ??
  ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p)) ??
  "ffmpeg"

export const streamUrl = (c: Connection, port = RTSPS_PORT) =>
  `rtsps://bblp:${encodeURIComponent(c.accessCode)}@${c.host}:${port}/streaming/live/1`

/** The one-entry ffconcat list ffmpeg reads from stdin: the stream, over TCP, TLS unverified. */
export const concatList = (c: Connection, port = RTSPS_PORT) =>
  [
    "ffconcat version 1.0",
    `file '${streamUrl(c, port).replaceAll("'", String.raw`'\''`)}'`,
    "option rtsp_transport tcp",
    "option tls_verify 0",
    "",
  ].join("\n")

/** ffmpeg's arguments: nothing secret, the list comes on stdin. */
export const pullArgs = () => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-protocol_whitelist",
  "pipe,rtsp,rtsps,tcp,tls,udp,rtp,crypto",
  "-i",
  "pipe:0",
  "-frames:v",
  "1",
  "-f",
  "image2pipe",
  "-c:v",
  "mjpeg",
  "-q:v",
  "4",
  "pipe:1",
]

/** Text with the access code and any URL's user info taken out. */
export const scrub = (text: string, accessCode: string) => {
  let out = text.replaceAll(/(?<scheme>rtsps?:\/\/)[^@\s/']*@/giu, "$<scheme>")
  for (const secret of new Set([accessCode, encodeURIComponent(accessCode)])) {
    if (secret !== "") {
      out = out.replaceAll(secret, "***")
    }
  }
  return out
}

/** The last line ffmpeg said, scrubbed, as a problem worth showing. */
export const problemOf = (stderr: string, accessCode: string, fallback: string) => {
  const lines = scrub(stderr, accessCode)
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*\]\s*/u, "").trim())
    .filter((l) => l !== "")
  const refused = lines.find((l) => /connection refused/iu.test(l))
  if (refused !== undefined) {
    return `Camera port ${RTSPS_PORT} is closed; turn on LAN Only Liveview on the printer`
  }
  const auth = lines.find((l) => /401|unauthori[sz]ed/iu.test(l))
  if (auth !== undefined) {
    return "Camera refused the access code"
  }
  const why = lines.find((l) => !/^error opening input|^impossible to open/iu.test(l))
  return why === undefined ? fallback : `Camera: ${why}`
}

/** A running ffmpeg as a pull sees it; tests give their own. */
export interface Child {
  /** Writes text to its stdin and closes it. */
  readonly input: (text: string) => void
  readonly onOut: (f: (chunk: Buffer) => void) => void
  readonly onErr: (f: (chunk: Buffer) => void) => void
  readonly onClose: (f: (code: number | null) => void) => void
  readonly onError: (f: (error: Error) => void) => void
  readonly kill: () => void
}
export type Spawner = (cmd: string, args: readonly string[]) => Child

const realSpawn: Spawner = (cmd, args) => {
  const child = spawn(cmd, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" },
  })
  // ffmpeg can exit before it reads its list; close says why, so a broken pipe is no crash.
  child.stdin.on("error", () => {
    /* empty */
  })
  return {
    input: (text) => {
      child.stdin.end(text)
    },
    onOut: (f) => {
      child.stdout.on("data", f)
    },
    onErr: (f) => {
      child.stderr.on("data", f)
    },
    onClose: (f) => {
      child.on("close", f)
    },
    onError: (f) => {
      child.on("error", f)
    },
    kill: () => {
      child.kill()
    },
  }
}

const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8

export class PullError extends Error {
  override readonly name = "PullError"
}

/** One JPEG from the stream now, or a PullError with a scrubbed reason. */
export const pullFrame = async (
  c: Connection,
  signal: AbortSignal,
  options: {
    readonly spawner?: Spawner
    readonly timeoutMs?: number
    readonly ffmpeg?: string
    readonly port?: number
  } = {},
): Promise<Buffer> => {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const child = (options.spawner ?? realSpawn)(options.ffmpeg ?? ffmpegPath(), pullArgs())
  const out: Buffer[] = []
  let size = 0
  let err = ""
  let settled = false
  const finish = (result: Buffer | PullError) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    if (result instanceof PullError) {
      reject(result)
    } else {
      resolve(result)
    }
  }
  const onAbort = () => {
    child.kill()
    finish(new PullError("Camera closed"))
  }
  const timer = setTimeout(() => {
    child.kill()
    finish(new PullError(problemOf(err, c.accessCode, "Camera timed out")))
  }, options.timeoutMs ?? PULL_MS)
  signal.addEventListener("abort", onAbort)
  child.onOut((chunk) => {
    size += chunk.length
    if (size > MAX_FRAME) {
      child.kill()
      finish(new PullError("Bad camera stream"))
      return
    }
    out.push(chunk)
  })
  child.onErr((chunk) => {
    err = (err + chunk.toString("utf-8")).slice(-4000)
  })
  child.onError((failure) => {
    finish(new PullError(scrub(`Camera: ${failure.message}`, c.accessCode)))
  })
  child.onClose((code) => {
    const jpeg = Buffer.concat(out)
    if (code === 0 && isJpeg(jpeg)) {
      finish(jpeg)
    } else {
      finish(
        new PullError(
          problemOf(err, c.accessCode, code === 0 ? "Bad camera stream" : "No picture"),
        ),
      )
    }
  })
  child.input(concatList(c, options.port))
  if (signal.aborted) {
    onAbort()
  }
  return await promise
}
