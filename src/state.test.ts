import { describe, expect, test } from "bun:test"

import { cellsFor, lineOf, swapOf } from "./board.ts"
import { shortOf } from "./short.ts"
import { track } from "./track.ts"
import { mergePush, slotsOf, viewOf } from "./state.ts"

const tray = (id: string, type: string, color: string) => ({
  id,
  tray_type: type,
  tray_color: `${color}FF`,
  tray_info_idx: "GFL99",
  tray_uuid: "0".repeat(32),
  tag_uid: "0".repeat(16),
})

const full = {
  gcode_state: "IDLE",
  nozzle_target_temper: 0,
  bed_target_temper: 0,
  ams: {
    tray_now: "255",
    tray_exist_bits: "1",
    ams: [
      {
        id: "0",
        tray: [tray("0", "PLA", "161616"), { id: "1", state: 0 }, { id: "2" }, { id: "3" }],
      },
    ],
  },
  vir_slot: [
    { id: "254", tray_type: "", tray_color: "00000000" },
    { id: "255", tray_type: "", tray_color: "00000000" },
  ],
}

describe("mergePush", () => {
  test("a unit pushed with only the slot that changed keeps the others", () => {
    const loaded = mergePush(full, {
      ams: {
        tray_exist_bits: "3",
        ams: [{ id: "0", tray: [{ ...tray("1", "PLA", "000000"), tray_uuid: "8222" }] }],
      },
    })
    const slots = slotsOf(loaded)
    expect(slots.map((s) => [s.slot, s.type, s.color, s.loaded])).toEqual([
      ["A1", "PLA", "161616", true],
      ["A2", "PLA", "000000", true],
      ["A3", undefined, undefined, false],
      ["A4", undefined, undefined, false],
    ])
    expect(slots[1]?.rfid).toBe(true)
  })

  test("a slot emptied keeps no stale type: the existence bits say", () => {
    const emptied = mergePush(full, {
      ams: { tray_exist_bits: "0", ams: [{ id: "0", tray: [{ id: "0", state: 0 }] }] },
    })
    expect(slotsOf(emptied)[0]).toMatchObject({ slot: "A1", loaded: false })
    expect(slotsOf(emptied)[0]?.type).toBeUndefined()
  })

  test("a second AMS and an AMS HT are their own slots", () => {
    const two = mergePush(full, {
      ams: {
        tray_exist_bits: "11",
        ams: [
          { id: "1", tray: [tray("0", "PETG", "FFFFFF"), { id: "1" }, { id: "2" }, { id: "3" }] },
          { id: "128", tray: [tray("0", "TPU", "000000")] },
        ],
      },
    })
    expect(slotsOf(two).map((s) => s.slot)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "B1",
      "B2",
      "B3",
      "B4",
      "HT1",
    ])
    expect(slotsOf(two).find((s) => s.slot === "HT1")).toMatchObject({
      tray: 512,
      type: "TPU",
      loaded: true,
    })
  })
})

const view = (raw: Record<string, unknown>) =>
  viewOf({ id: "h2c", name: "Delta", model: "H2C" }, raw, true, new Map(), 0)

describe("the widget", () => {
  test("every slot and the external spool, by name and what it holds", () => {
    const spooled = mergePush(full, {
      vir_slot: [{ id: "255", tray_type: "PETG", tray_color: "FFFFFFFF" }],
    })
    expect(cellsFor(view(spooled)).map((c) => [c.title, c.label, c.swatch, c.args.slot])).toEqual([
      ["A1", "PLA", "161616", "A1"],
      ["A2", "", "", "A2"],
      ["A3", "", "", "A3"],
      ["A4", "", "", "A4"],
      ["Ext", "PETG", "FFFFFF", "ext"],
    ])
  })

  test("a P1P without an AMS: its external spool", () => {
    const p1p = {
      gcode_state: "IDLE",
      vt_tray: { id: "254", tray_type: "PLA", tray_color: "000000FF" },
    }
    expect(cellsFor(view(p1p)).map((c) => [c.title, c.label])).toEqual([["Ext", "PLA"]])
  })

  test("setting a P1P's external spool says its slots changed, so its widget redraws", () => {
    const before = {
      gcode_state: "IDLE",
      vt_tray: { id: "254", tray_type: "PLA", tray_color: "000000FF" },
    }
    const after = {
      ...before,
      vt_tray: { ...before.vt_tray, tray_type: "PETG", tray_color: "FFFFFFFF" },
    }
    const first = track(undefined, view(before), undefined, 0, undefined, 0)
    const next = track(first.seen, view(after), undefined, 1, undefined, 1)
    expect(next.drafts.filter((d) => d.type === "printers.slots_changed")).toMatchObject([
      { payload: { slots: [{ slot: "ext", type: "PETG", color: "FFFFFF" }] } },
    ])
  })

  test("printing says its percent and the time left, in words", () => {
    const line = lineOf(
      view({ ...full, gcode_state: "RUNNING", mc_percent: 43, mc_remaining_time: 72 }),
    )
    expect(line.detail).toBe("Printing 43% · 1h 12m left")
    expect(line.mark).toBe("")
    expect(line.endsAt).toBe(72 * 60_000)
  })

  test("the swap offers what's on hand first, and any color", () => {
    const [type, color, brand] = swapOf([{ type: "pva", color: "f0e6d2" }])
    expect(brand).toBeUndefined()
    expect(type?.choices.slice(0, 2)).toEqual(["PVA", "PLA"])
    expect(color?.choices[0]).toBe("F0E6D2")
    expect(color).toMatchObject({ swatches: true, custom: true })
  })
})

describe("trouble in a word or two", () => {
  test("the usual ones by what they say", () => {
    expect(
      shortOf(
        "Nozzle camera lens is dirty, which may affect the AI monitoring functionality. Please clean the surface of the nozzle camera lens as soon as possible.",
      ),
    ).toBe("Lens dirty")
    expect(shortOf("AMS-HT F Slot 3 filament has run out. Please insert a new filament.")).toBe(
      "Filament out",
    )
    expect(shortOf("The heatbed temperature is abnormal; the heater may be broken.")).toBe(
      "Bed temp",
    )
  })

  test("any other by its own first words", () => {
    expect(shortOf("Failed to extrude the filament.")).toBe("Extrude failed")
    expect(shortOf("Homing Z axis failed: temperature control abnormality.")).toBe("Homing failed")
    expect(shortOf("The toolhead voltage is low.")).toBe("Voltage low")
  })

  test("the plate says it short; the note says it whole", () => {
    const lens = "Nozzle camera lens is dirty, which may affect the AI monitoring functionality."
    const line = lineOf(
      viewOf(
        { id: "h2c", name: "Delta", model: "H2C" },
        { ...full, gcode_state: "RUNNING", hms: [{ attr: 0x0c_00_01_00, code: 0x00_02_00_01 }] },
        true,
        new Map([["0C00010000020001", lens]]),
        0,
      ),
    )
    expect(line).toMatchObject({ detail: "Lens dirty · 0%", note: lens, alert: true, mark: "warn" })
  })
})
