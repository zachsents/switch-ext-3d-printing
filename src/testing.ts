// Test helpers.
import type { Child, Spawner } from "./rtsps.ts"

type Listener<T> = (value: T) => void

/** What a fake ffmpeg does once it has its list. */
export interface Act {
  readonly out: (chunk: Buffer) => void
  readonly err: (chunk: Buffer) => void
  readonly close: (code: number) => void
}

export interface Call {
  readonly cmd: string
  readonly args: readonly string[]
  stdin: string
  killed: boolean
}

/** A fake ffmpeg: the calls made to it, and `act` for what it does. */
export const fakeSpawner = (act: (a: Act) => void) => {
  const calls: Call[] = []
  const spawner: Spawner = (cmd, args) => {
    const call: Call = { cmd, args, stdin: "", killed: false }
    calls.push(call)
    const outs: Listener<Buffer>[] = []
    const errs: Listener<Buffer>[] = []
    const closes: Listener<number | null>[] = []
    const child: Child = {
      input: (text) => {
        call.stdin = text
        queueMicrotask(() => {
          act({
            out: (chunk) => {
              for (const f of outs) {
                f(chunk)
              }
            },
            err: (chunk) => {
              for (const f of errs) {
                f(chunk)
              }
            },
            close: (code) => {
              for (const f of closes) {
                f(code)
              }
            },
          })
        })
      },
      onOut: (f) => {
        outs.push(f)
      },
      onErr: (f) => {
        errs.push(f)
      },
      onClose: (f) => {
        closes.push(f)
      },
      onError: () => {
        /* empty */
      },
      kill: () => {
        call.killed = true
      },
    }
    return child
  }
  return { spawner, calls }
}
