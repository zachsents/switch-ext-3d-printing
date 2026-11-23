import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import tls from "node:tls"

import type { Connection } from "./config.ts"
import { CLIENT, frame, frames, plateRoute, SERVER, tunnelUpload } from "./tunnel.ts"

const CODE = "a1b2C3d4"

type Json = Record<string, unknown>
const record = (x: unknown): Json =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x))
    : {}

// Pushes as the printers send them: Delta (H2C) and Echo (P2S) set fun bit 31 (the :6000
// tunnel and brtc:// URLs); a P1 sends no fun at all.
const H2C = { fun: "14027FF18FFF9CB3", sdcard: false }
const P2S = { fun: "64039FD193FF9CB3", sdcard: false }
const P1S = { sdcard: true }

describe("plateRoute", () => {
  test("an H2C goes to its internal storage over the tunnel, started from brtc://emmc/", () => {
    expect(plateRoute(H2C, "J-1.gcode.3mf")).toEqual({
      via: "tunnel",
      url: "brtc://emmc/J-1.gcode.3mf",
    })
    expect(plateRoute(P2S, "J-1.gcode.3mf").via).toBe("tunnel")
  })

  test("a P1 keeps its microSD over FTPS, started from ftp:///", () => {
    expect(plateRoute(P1S, "J-1.gcode.3mf")).toEqual({ via: "card", url: "ftp:///J-1.gcode.3mf" })
    expect(plateRoute({}, "J-1.gcode.3mf").via).toBe("card")
    expect(plateRoute({ fun: "not hex" }, "J-1.gcode.3mf").via).toBe("card")
  })
})

describe("frames", () => {
  test("a frame reads back whole, and a partial one waits", () => {
    const one = frame(CLIENT.ctrl, 7, Buffer.from('{"a":1}'))
    expect(one.readUInt32LE(0)).toBe(7)
    expect(one.readUInt32LE(4)).toBe(0x01_02_01_3f)
    const both = Buffer.concat([one, frame(SERVER.login, 8, Buffer.alloc(4))])
    const { got, rest } = frames(both.subarray(0, -2))
    expect(got).toHaveLength(1)
    expect(got[0]?.payload.toString()).toBe('{"a":1}')
    expect(rest).toHaveLength(18)
  })
})

/** A printer's :6000 that takes an upload the way the H2C does, keeping what it was sent. */
const fakePrinter = async (init: { result: number; chunkKiB: number }) => {
  const seen: { login: Buffer | null; json: Json[]; data: Buffer[] } = {
    login: null,
    json: [],
    data: [],
  }
  const dir = path.join(import.meta.dir, "testdata")
  const server = tls.createServer(
    {
      key: readFileSync(path.join(dir, "key.pem")),
      cert: readFileSync(path.join(dir, "cert.pem")),
    },
    (socket) => {
      let buf: Buffer = Buffer.alloc(0)
      let total = 0
      let got = 0
      const reply = (body: Record<string, unknown>) =>
        socket.write(frame(SERVER.ctrl, 0, Buffer.from(JSON.stringify(body))))
      socket.on("data", (chunk: Buffer) => {
        const read = frames(Buffer.concat([buf, chunk]))
        buf = read.rest
        for (const f of read.got) {
          if (f.magic === CLIENT.login) {
            seen.login = f.payload
            socket.write(frame(SERVER.login, 0, Buffer.alloc(4)))
            continue
          }
          const at = f.payload.indexOf("\n\n")
          const head = at === -1 ? f.payload : f.payload.subarray(0, at)
          const body = record(JSON.parse(head.toString()))
          const req = record(body.req)
          seen.json.push(body)
          if (body.mtype === 12_291) {
            reply({ mtype: 12_291, sequence: 0, result: 0, reply: {} })
          } else if (body.cmdtype === 5 && at === -1) {
            total = Number(req.total)
            reply({
              cmdtype: 5,
              mtype: 12_289,
              result: init.result,
              sequence: body.sequence,
              reply: { chunk_size: init.chunkKiB, offset: 0 },
            })
          } else if (body.cmdtype === 5) {
            const data = f.payload.subarray(at + 2)
            seen.data.push(data)
            got += data.length
            if (got === total) {
              reply({ cmdtype: 5, mtype: 12_289, result: 0, sequence: body.sequence })
            }
          }
        }
      })
    },
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { seen, port, close: () => server.close() }
}

const work = mkdtempSync(path.join(tmpdir(), "tunnel-test-"))
afterEach(() => {
  rmSync(path.join(work, "plate.gcode.3mf"), { force: true })
})

const plate = (bytes: number) => {
  const file = path.join(work, "plate.gcode.3mf")
  const body = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 1) {
    body[i] = i % 251
  }
  writeFileSync(file, body)
  return { file, body }
}

const conn: Connection = {
  host: "127.0.0.1",
  serial: "31B8AP000000000",
  accessCode: CODE,
}

describe("tunnelUpload", () => {
  test("logs in, then sends the plate to emmc in chunks, the last with the file's md5", async () => {
    const printer = await fakePrinter({ result: 1, chunkKiB: 1 })
    try {
      const { file, body } = plate(2500)
      await tunnelUpload(conn, file, "J-1.gcode.3mf", { port: printer.port })
      expect(printer.seen.login?.subarray(0, 4).toString()).toBe("bblp")
      expect(printer.seen.login?.subarray(8, 16).toString()).toBe(CODE)
      const init = printer.seen.json.find((j) => j.cmdtype === 5)
      expect(init?.req).toEqual({
        type: "model",
        storage: "emmc",
        path: "J-1.gcode.3mf",
        total: 2500,
      })
      expect(printer.seen.data.map((d) => d.length)).toEqual([1024, 1024, 452])
      expect(Buffer.concat(printer.seen.data).equals(body)).toBe(true)
      const chunks = printer.seen.json
        .map((j) => record(j.req))
        .filter((r) => r.frag_id !== undefined)
      expect(chunks.map((c) => c.offset)).toEqual([0, 1024, 2048])
      expect(chunks.at(-1)?.file_md5).toBe(createHash("md5").update(body).digest("hex"))
      expect(chunks[0]?.file_md5).toBeUndefined()
    } finally {
      printer.close()
    }
  })

  test("a name already there (19) is overwritten, as Studio does", async () => {
    const printer = await fakePrinter({ result: 19, chunkKiB: 255 })
    try {
      const { file } = plate(300)
      await tunnelUpload(conn, file, "J-1.gcode.3mf", { port: printer.port })
      expect(printer.seen.data.map((d) => d.length)).toEqual([300])
    } finally {
      printer.close()
    }
  })

  test("a refused upload says so, with the printer's result", async () => {
    const printer = await fakePrinter({ result: 2, chunkKiB: 255 })
    try {
      const { file } = plate(300)
      let message = ""
      try {
        await tunnelUpload(conn, file, "J-1.gcode.3mf", { port: printer.port })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("result 2")
      expect(message).not.toContain(CODE)
    } finally {
      printer.close()
    }
  })
})
