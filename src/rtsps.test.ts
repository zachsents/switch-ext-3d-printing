import { describe, expect, test } from "bun:test"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import path from "node:path"
import tls from "node:tls"

import type { Connection } from "./config.ts"
import { concatList, pullArgs, pullFrame, problemOf, RTSPS_MODELS, scrub } from "./rtsps.ts"
import { fakeSpawner } from "./testing.ts"

const CODE = "a1b2C3d4"
const conn: Connection = { host: "192.0.2.10", serial: "31B8AP000000000", accessCode: CODE }
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])

/** The message a pull failed with, "" if it didn't. */
const failure = async (pulling: Promise<Buffer>) => {
  try {
    await pulling
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe("rtsps", () => {
  test("H2C, X1 and P2S use it, P1 and A1 don't", () => {
    expect(RTSPS_MODELS.has("H2C")).toBe(true)
    expect(RTSPS_MODELS.has("X1C")).toBe(true)
    expect(RTSPS_MODELS.has("P1S")).toBe(false)
    expect(RTSPS_MODELS.has("P2S")).toBe(true)
    expect(RTSPS_MODELS.has("A1")).toBe(false)
  })

  test("the access code is in the stdin list, never in the arguments", () => {
    expect(pullArgs().join(" ")).not.toContain(CODE)
    expect(pullArgs()).toContain("pipe:0")
    const list = concatList(conn)
    expect(list).toContain(`file 'rtsps://bblp:${CODE}@192.0.2.10:322/streaming/live/1'`)
    expect(list).toContain("option rtsp_transport tcp")
    expect(list).toContain("option tls_verify 0")
  })

  test("a quote in the code can't break out of the list entry", () => {
    const list = concatList({ ...conn, accessCode: "ab'cd" })
    expect(list).not.toContain("ab'cd")
  })

  test("scrub takes out the code and URL user info", () => {
    const text = `Impossible to open 'rtsps://bblp:${CODE}@192.0.2.10:322/streaming/live/1' ${CODE}`
    const clean = scrub(text, CODE)
    expect(clean).not.toContain(CODE)
    expect(clean).toContain("rtsps://192.0.2.10:322")
  })

  test("problems say what's wrong, without the code", () => {
    const refused = `[tcp @ 0x1] Connection to tcp://192.0.2.10:322 failed: Connection refused\n[in#0] Impossible to open 'rtsps://bblp:${CODE}@192.0.2.10:322/streaming/live/1'`
    expect(problemOf(refused, CODE, "x")).toContain("LAN Only Liveview")
    expect(problemOf("[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized", CODE, "x")).toBe(
      "Camera refused the access code",
    )
    const other = problemOf(`[rtsp @ 1] weird ${CODE}\nError opening input files: x`, CODE, "x")
    expect(other).not.toContain(CODE)
    expect(problemOf("", CODE, "No picture")).toBe("No picture")
  })

  test("a pull gives the JPEG ffmpeg wrote", async () => {
    const { spawner, calls } = fakeSpawner(({ out, close }) => {
      out(JPEG.subarray(0, 3))
      out(JPEG.subarray(3))
      close(0)
    })
    const jpeg = await pullFrame(conn, new AbortController().signal, { spawner, ffmpeg: "ffmpeg" })
    expect(jpeg.equals(JPEG)).toBe(true)
    expect(calls[0]?.args.join(" ")).not.toContain(CODE)
    expect(calls[0]?.stdin).toContain(CODE)
  })

  test("a failed pull rejects with a scrubbed reason", async () => {
    const { spawner } = fakeSpawner(({ err, close }) => {
      err(Buffer.from(`Impossible to open 'rtsps://bblp:${CODE}@h:322/x': Connection refused\n`))
      close(1)
    })
    const error = await pullFrame(conn, new AbortController().signal, { spawner }).catch(
      (error_: unknown) => error_,
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(CODE)
    expect(String(error)).toContain("LAN Only Liveview")
  })

  test("output that isn't a JPEG is no frame", async () => {
    const { spawner } = fakeSpawner(({ out, close }) => {
      out(Buffer.from("nope"))
      close(0)
    })
    expect(await failure(pullFrame(conn, new AbortController().signal, { spawner }))).toBe(
      "Bad camera stream",
    )
  })

  test("a pull that hangs is killed at the timeout", async () => {
    const { spawner, calls } = fakeSpawner(() => {})
    expect(
      await failure(pullFrame(conn, new AbortController().signal, { spawner, timeoutMs: 20 })),
    ).toBe("Camera timed out")
    expect(calls[0]?.killed).toBe(true)
  })

  test("closing the stream kills the pull", async () => {
    const { spawner, calls } = fakeSpawner(() => {})
    const stop = new AbortController()
    const pulling = pullFrame(conn, stop.signal, { spawner })
    stop.abort()
    expect(await failure(pulling)).toBe("Camera closed")
    await Bun.sleep(0)
    expect(calls[0]?.killed).toBe(true)
  })

  // Real ffmpeg against a local TLS server with a self-signed cert: it connects without verifying,
  // over TCP, sends the code only as RTSP auth, and its failure comes back without the code.
  test("real ffmpeg: unverified TLS, code only in the auth header", async () => {
    const dir = path.join(import.meta.dir, "testdata")
    const seen: string[] = []
    const server = tls.createServer(
      {
        key: readFileSync(path.join(dir, "key.pem")),
        cert: readFileSync(path.join(dir, "cert.pem")),
      },
      (socket) => {
        socket.on("data", (d: Buffer) => {
          seen.push(d.toString("utf-8"))
          const cseq = /CSeq: (?<n>\d+)/u.exec(d.toString("utf-8"))?.groups?.n ?? "1"
          socket.write(
            `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Basic realm="x"\r\n\r\n`,
          )
        })
      },
    )
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const local = { host: "127.0.0.1", serial: "x", accessCode: CODE }
    const error = await pullFrame(local, new AbortController().signal, {
      port,
      timeoutMs: 10_000,
    }).catch((error_: unknown) => error_)
    server.close()
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(CODE)
    expect(error instanceof Error && error.message).toBe("Camera refused the access code")
    const all = seen.join("")
    expect(all).toContain("rtsps://127.0.0.1")
    expect(all).not.toContain(CODE)
    expect(all).toContain(`Authorization: Basic ${Buffer.from(`bblp:${CODE}`).toString("base64")}`)
  })
})
