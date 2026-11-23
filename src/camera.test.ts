import { describe, expect, test } from "bun:test"

import { Camera, eyeFor, makeRtspsEye, rtspsEye, tlsEye } from "./camera.ts"
import { fakeSpawner } from "./testing.ts"

const conn = { host: "192.0.2.10", serial: "31B8AP000000000", accessCode: "a1b2C3d4" }
const jpegN = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9])

describe("camera", () => {
  test("H2C and X1C get the RTSPS camera, P1S and P2S the port-6000 one", () => {
    expect(eyeFor("H2C")).toBe(rtspsEye)
    expect(eyeFor("X1C")).toBe(rtspsEye)
    expect(eyeFor("P1S")).toBe(tlsEye)
    expect(eyeFor("P2S")).toBe(tlsEye)
  })

  test("an RTSPS camera gives a new live frame per pull, then stops pulling when let go", async () => {
    let n = 0
    const { spawner, calls } = fakeSpawner(({ out, close }) => {
      n += 1
      out(jpegN(n))
      close(0)
    })
    const camera = new Camera("h2c", makeRtspsEye({ spawner, everyMs: 5, read: () => conn }))
    const first = await camera.frame()
    expect(first?.source).toBe("live")
    expect(first?.jpeg[2]).toBe(1)
    await Bun.sleep(40)
    const later = await camera.frame()
    expect(later?.source).toBe("live")
    expect(later?.jpeg[2] ?? 0).toBeGreaterThan(1)
    expect(later?.at ?? 0).toBeGreaterThanOrEqual(first?.at ?? 0)
    camera.stop()
    expect(camera.latest?.source).toBe("kept")
    const pulls = calls.length
    await Bun.sleep(30)
    expect(calls.length).toBe(pulls)
  })

  test("a failing RTSPS camera shows no frame and says why, without the code", async () => {
    const { spawner } = fakeSpawner(({ err, close }) => {
      err(Buffer.from(`rtsps://bblp:${conn.accessCode}@x:322 Connection refused\n`))
      close(1)
    })
    const camera = new Camera("h2c", makeRtspsEye({ spawner, read: () => conn }))
    const frame = await camera.frame()
    camera.stop()
    expect(frame).toBeUndefined()
    expect(camera.problem).toContain("LAN Only Liveview")
    expect(camera.problem).not.toContain(conn.accessCode)
  })

  test("after a failure, a kept frame is never passed off as live", async () => {
    let fail = false
    const { spawner } = fakeSpawner(({ out, close }) => {
      if (fail) {
        close(1)
        return
      }
      out(jpegN(7))
      close(0)
    })
    const camera = new Camera("h2c", makeRtspsEye({ spawner, everyMs: 5, read: () => conn }))
    const first = await camera.frame()
    expect(first?.source).toBe("live")
    fail = true
    await Bun.sleep(30)
    expect(camera.latest?.source).toBe("kept")
    camera.stop()
  })
})
