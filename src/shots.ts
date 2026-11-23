// A timelapse's frames, taken from the camera's stream.
import { existsSync, readdirSync, renameSync, statfsSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { Camera } from "./camera.ts"

/** Free bytes under which no frames are saved (the CLI's DISK_FLOOR). */
const DISK_FLOOR = 5e8

export const nearest = (p: string): string => (existsSync(p) ? p : nearest(path.dirname(p)))

export const freeBytes = (p: string) => {
  const s = statfsSync(nearest(p))
  return s.bavail * s.bsize
}

/** A recording's frames, oldest first; an exFAT drive's AppleDouble twins (._00001.jpg) aren't. */
export const framesOf = (folder: string) =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter((f) => f.endsWith(".jpg") && !f.startsWith("."))
        .toSorted()
    : []

export const log = (id: string, words: string) => {
  console.error(`timelapse ${id}: ${words}`)
}

/**
 * A recording's frames folder: NNNNN.jpg, each written via a .tmp so readers never see half a JPEG,
 * from the camera's newest frame when it's new. Logs only when snapping starts or stops failing, so a
 * camera that's down for an hour costs two log lines (the CLI's Frames).
 */
export class Shots {
  n: number
  private lastFrame = 0
  /** What's failing, "" while frames are saved. */
  private problem = ""
  private readonly folder: string
  private readonly camera: Camera
  private readonly id: string

  constructor(folder: string, camera: Camera, id: string) {
    this.folder = folder
    this.camera = camera
    this.id = id
    this.n = framesOf(folder).length
  }

  snap() {
    const problem =
      freeBytes(this.folder) < DISK_FLOOR ? "under 0.5 GB free; not saving frames" : this.take()
    if (problem !== this.problem) {
      log(this.id, problem || `snapping again (frame ${this.n})`)
      this.problem = problem
    }
  }

  private take(): string {
    const frame = this.camera.latest
    if (frame?.source !== "live" || frame.at <= this.lastFrame) {
      return `snap failed: ${this.camera.problem || "no new frame"}`
    }
    const file = path.join(this.folder, `${String(this.n).padStart(5, "0")}.jpg`)
    try {
      writeFileSync(`${file}.tmp`, frame.jpeg)
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      return `snap failed: ${String(error)}`
    }
    this.n += 1
    this.lastFrame = frame.at
    return ""
  }
}
