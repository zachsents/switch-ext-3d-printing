// The printer's file tunnel on TLS port 6000 (Bambu's BambuTunnelLocal), as Bambu Studio sends a LAN
// print to an H2 or P2S. Those printers keep plates in 8 GB of internal storage (emmc); their FTPS
// on 990 serves only a USB drive in the top port, so with none in, its root is empty and every STOR
// answers 553. Studio writes the plate into the internal model cache over this tunnel and starts it
// from brtc://emmc/<name>. A printer says it has the tunnel with bit 31 of its report's `fun`.
//
// The wire, each frame a 16-byte little-endian header (payload length, magic, sequence, 0) then the
// payload: a login on subchannel 1 (user and access code, 8 bytes each, NUL padded), a stream setup
// on subchannel 2, then JSON commands there. An upload is cmdtype 5 on one sequence: an init the
// printer answers with its chunk size in KiB, every chunk back to back (JSON, "\n\n", the bytes; the
// last carries the whole file's md5), then one final reply. The printer refuses a pipeline it has to
// acknowledge chunk by chunk, so nothing is read between chunks.
import { createHash } from "node:crypto"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import path from "node:path"
import tls from "node:tls"

import type { Connection } from "./config.ts"

/** Frame magics: byte 6 is the subchannel (1 login, 2 control), byte 7 the direction (1 client). */
export const CLIENT = { login: 0x01_01_01_3f, ctrl: 0x01_02_01_3f } as const
export const SERVER = { login: 0x00_01_01_3f, ctrl: 0x00_02_01_3f } as const

const PORT = 6000
const CTRL = 12_289
const SETUP = 12_291
const UPLOAD = 5
/** Upload init: a new file, or one by that name already there (overwritten, as Studio does). */
const CONTINUE = 1
const FILE_EXIST = 19
const TIMEOUT_MS = 30_000

export interface Frame {
  readonly magic: number
  readonly payload: Buffer
}

export const frame = (magic: number, seq: number, payload: Buffer) => {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(payload.length, 0)
  header.writeUInt32LE(magic, 4)
  header.writeUInt32LE(seq % 0x1_00_00_00_00, 8)
  return Buffer.concat([header, payload])
}

/** The whole frames at the front of `buf`, and what's left of a partial one. */
export const frames = (buf: Buffer) => {
  const got: Frame[] = []
  let rest = buf
  while (rest.length >= 16) {
    const length = rest.readUInt32LE(0)
    if (rest.length < 16 + length) {
      break
    }
    got.push({ magic: rest.readUInt32LE(4), payload: rest.subarray(16, 16 + length) })
    rest = rest.subarray(16 + length)
  }
  return { got, rest }
}

/** Whether a printer's report says it has the :6000 tunnel and brtc:// URLs (`fun` bit 31). */
export const hasTunnel = (raw: Readonly<Record<string, unknown>>) => {
  const { fun } = raw
  if (typeof fun !== "string" || !/^[0-9a-f]+$/iu.test(fun)) {
    return false
  }
  // Bit 31 is the top bit of the low 32: set when the last eight hex digits are 80000000 or more.
  return Number.parseInt(fun.slice(-8), 16) >= 0x80_00_00_00
}

/**
 * How a plate reaches a printer and the project_file URL that starts it: an H2 or P2S over the
 * tunnel into internal storage, any other over FTPS to its microSD card.
 */
export const plateRoute = (raw: Readonly<Record<string, unknown>>, file: string) =>
  hasTunnel(raw)
    ? { via: "tunnel" as const, url: `brtc://emmc/${file}` }
    : { via: "card" as const, url: `ftp:///${file}` }

interface Reply {
  readonly login: boolean
  readonly cmdtype: number | undefined
  readonly mtype: number | undefined
  readonly sequence: number | undefined
  readonly result: number | undefined
  readonly chunkSize: number | undefined
  readonly offset: number | undefined
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)
const num = (x: unknown) => (typeof x === "number" ? x : undefined)

/** A control frame's JSON head as a reply, or null for a frame that isn't one (camera bytes). */
export const replyOf = (payload: Buffer): Reply | null => {
  const at = payload.indexOf("\n\n")
  let json: unknown = null
  try {
    json = JSON.parse((at === -1 ? payload : payload.subarray(0, at)).toString("utf-8"))
  } catch {
    return null
  }
  if (!isRecord(json)) {
    return null
  }
  const reply = isRecord(json.reply) ? json.reply : {}
  return {
    login: false,
    cmdtype: num(json.cmdtype),
    mtype: num(json.mtype),
    sequence: num(json.sequence),
    result: num(json.result),
    chunkSize: num(reply.chunk_size),
    offset: num(reply.offset),
  }
}

/** A TLS session on the tunnel: frames out, the printer's replies in, each taken by a test. */
const open = async (conn: Connection, port: number) => {
  const socket = tls.connect({ host: conn.host, port, rejectUnauthorized: false })
  let seq = Math.floor(Math.random() * 0x7f_ff_ff_ff)
  let buf: Buffer = Buffer.alloc(0)
  let failed: Error | null = null
  const replies: Reply[] = []
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const l of listeners) {
      l()
    }
  }
  socket.on("data", (chunk: Buffer) => {
    const read = frames(Buffer.concat([buf, chunk]))
    buf = read.rest
    for (const f of read.got) {
      const reply =
        f.magic === SERVER.login
          ? {
              login: true,
              cmdtype: undefined,
              mtype: undefined,
              sequence: undefined,
              result: undefined,
              chunkSize: undefined,
              offset: undefined,
            }
          : replyOf(f.payload)
      if (reply && (f.magic === SERVER.login || f.magic === SERVER.ctrl)) {
        replies.push(reply)
      }
    }
    changed()
  })
  const fail = (error: Error) => {
    failed ??= error
    changed()
  }
  socket.on("error", (error) => {
    fail(new Error(`${conn.host}:${port}: ${error.message}`))
  })
  socket.on("close", () => {
    fail(new Error(`${conn.host}:${port} closed the tunnel`))
  })
  await once(socket, "secureConnect")
  const send = (magic: number, payload: Buffer) => {
    seq = (seq + 1) % 0xff_ff_ff_ff
    socket.write(frame(magic, seq, payload))
  }
  /** The first reply passing `test`, taken off the queue with the stale ones before it. */
  const take = async (test: (r: Reply) => boolean, what: string): Promise<Reply> => {
    const { promise, resolve, reject } = Promise.withResolvers<Reply>()
    const check = () => {
      const at = replies.findIndex(test)
      if (at !== -1) {
        const hit = replies[at]
        replies.splice(0, at + 1)
        stop()
        if (hit) {
          resolve(hit)
        }
      } else if (failed) {
        stop()
        reject(new Error(`${what}: ${failed.message}`))
      }
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`${what}: no answer from ${conn.host}:${port} in ${TIMEOUT_MS / 1000} s`))
    }, TIMEOUT_MS)
    const stop = () => {
      clearTimeout(timer)
      listeners.delete(check)
    }
    listeners.add(check)
    check()
    return await promise
  }
  try {
    const login = Buffer.alloc(16)
    login.write("bblp", 0, 8, "utf-8")
    login.write(conn.accessCode, 8, 8, "utf-8")
    send(CLIENT.login, login)
    await take((r) => r.login, "tunnel login")
    const setup = { t_av: 0, mtype: CTRL, peer_t: 3, pid: "", ver: "" }
    send(CLIENT.ctrl, Buffer.from(JSON.stringify({ sequence: 0, mtype: SETUP, req: setup })))
    const ack = await take((r) => r.mtype === SETUP, "tunnel setup")
    if (ack.result !== 0) {
      throw new Error(`tunnel setup: refused (result ${String(ack.result)}); check the access code`)
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
  return {
    send,
    take,
    close: () => socket.end(),
  }
}

/**
 * Sends `local` into the printer's internal storage as `name` (a basename: the printer flattens any
 * path), resolving once the printer confirms the whole file arrived.
 */
export const tunnelUpload = async (
  conn: Connection,
  local: string,
  name: string,
  options: { readonly port?: number } = {},
) => {
  const body = readFileSync(local)
  const md5 = createHash("md5").update(body).digest("hex")
  const remote = path.basename(name)
  const session = await open(conn, options.port ?? PORT)
  try {
    const sequence = 1
    const command = (req: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ mtype: CTRL, cmdtype: UPLOAD, sequence, req }))
    const ours = (r: Reply) => r.cmdtype === UPLOAD && r.sequence === sequence
    session.send(
      CLIENT.ctrl,
      command({ type: "model", storage: "emmc", path: remote, total: body.length }),
    )
    const init = await session.take(ours, `upload ${remote}`)
    if (init.result !== CONTINUE && init.result !== FILE_EXIST) {
      throw new Error(`upload ${remote}: the printer refused it (result ${String(init.result)})`)
    }
    const kib = init.chunkSize ?? 0
    if (!(kib > 0)) {
      throw new Error(`upload ${remote}: the printer gave no chunk size`)
    }
    const size = kib * 1024
    const separator = Buffer.from("\n\n")
    let id = 0
    for (let offset = init.offset ?? 0; offset < body.length; id += 1) {
      const piece = body.subarray(offset, offset + size)
      const last = offset + piece.length >= body.length
      session.send(
        CLIENT.ctrl,
        Buffer.concat([
          command({
            frag_id: id,
            offset,
            size: piece.length,
            ...(last ? { file_md5: md5 } : {}),
          }),
          separator,
          piece,
        ]),
      )
      offset += piece.length
    }
    const done = await session.take((r) => ours(r) && r.result !== CONTINUE, `upload ${remote}`)
    if (done.result !== 0) {
      throw new Error(
        `upload ${remote}: the printer didn't take it (result ${String(done.result)})`,
      )
    }
  } finally {
    session.close()
  }
}
