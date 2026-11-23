// A printer's trouble in a word or two, for a widget's plate: "Lens dirty", "Filament out". The
// whole message stays beside it (the widget's note, the status tool's errors).

/** The usual troubles, by what their message says, first match wins. */
const KNOWN: readonly (readonly [RegExp, string])[] = [
  [/lens.*(?:dirty|smudg|stain)|(?:dirty|smudg).*lens/iu, "Lens dirty"],
  [/run(?:s)? out|ran out|out of filament|filament.*(?:depleted|exhausted)/iu, "Filament out"],
  [/tangl/iu, "Filament tangled"],
  [/clog/iu, "Nozzle clog"],
  [/spaghetti/iu, "Spaghetti"],
  [/first layer/iu, "First layer"],
  [
    /foreign object|object on the (?:build )?plate|plate is not (?:empty|clear)/iu,
    "Plate not clear",
  ],
  [/(?:build )?plate.*(?:not|missing|wrong|misplac)|no (?:build )?plate/iu, "Plate missing"],
  [/(?:door|cover|lid).*(?:open|fell|removed)/iu, "Door open"],
  [/cutter/iu, "Cutter stuck"],
  [/skipp(?:ed|ing) steps?|step loss/iu, "Skipped steps"],
  [/(?:heat ?bed|bed).*temperature|temperature.*(?:heat ?bed|bed)/iu, "Bed temp"],
  [/(?:nozzle|hotend|hot end).*temperature|temperature.*(?:nozzle|hotend)/iu, "Nozzle temp"],
  [/(?:chamber).*temperature/iu, "Chamber temp"],
  [/fan/iu, "Fan fault"],
  [/humidity|desiccant/iu, "AMS humid"],
  [/rfid/iu, "RFID unread"],
  [/broken/iu, "Filament broken"],
  [/slot ?\d is empty|insert a new filament/iu, "Slot empty"],
  [
    /failed to (?:feed|pull|load)|feeds? filament .*timeout|pulls? filament .*timeout/iu,
    "Feed failed",
  ],
  [/motor .*(?:stall|slip|resistance)|(?:stall|slip).*motor/iu, "Motor stalled"],
  [/(?:sensor|odometer|hall).*(?:disconnect|no signal|lost|fault|abnormal)/iu, "Sensor fault"],
  [/heater|drying|thermal runaway/iu, "AMS heater"],
  [/\bams\b/iu, "AMS fault"],
  [/homing/iu, "Homing failed"],
  [/power (?:loss|failure|outage)/iu, "Power loss"],
  [/force sensor|strain/iu, "Bed sensor"],
  [/laser/iu, "Laser"],
  [/firmware|upgrade/iu, "Update"],
  [/calibrat/iu, "Calibration"],
  [/(?:sd|micro ?sd|storage|card)/iu, "Storage"],
  [/camera/iu, "Camera"],
  [/cancel/iu, "Cancelled"],
]

const titled = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** A message's own first words, cut to two: "Extrude failed", "Temperature abnormal". */
const ownWords = (text: string): string => {
  const clause = text.split(/[,.;:(，]/u)[0]?.trim() ?? ""
  const words = clause.split(/\s+/u).filter((w) => !/^(?:the|a|an|please|\d+)$/iu.test(w))
  const lead = words[0]?.toLowerCase() ?? ""
  // "Failed to extrude": "Extrude failed"; "Unable to start": "Can't start".
  const [, second = "", third = ""] = words
  if ((lead === "failed" || lead === "unable") && second.toLowerCase() === "to" && third !== "") {
    return titled(lead === "failed" ? `${third} failed` : `Can't ${third}`)
  }
  if (lead === "no" && second !== "") {
    return titled(`No ${second}`)
  }
  // "X Y is Z": "Y Z" ("The heatbed temperature is abnormal": "Temperature abnormal").
  const verb = words.findIndex((w) =>
    /^(?:is|are|was|were|has|have|may|cannot|can't|failed)$/iu.test(w),
  )
  if (verb > 0 && verb < words.length - 1) {
    const what = words.slice(verb + 1).find((w) => !/^(?:been|be|not|too|to)$/iu.test(w)) ?? ""
    return titled(`${words[verb - 1] ?? ""} ${what}`.trim())
  }
  return titled(words.slice(0, 2).join(" ")) || text
}

/** A word or two for a message; the message's own first words when it's none of the usual. */
export const shortOf = (message: string): string => {
  const text = message.trim()
  for (const [pattern, label] of KNOWN) {
    if (pattern.test(text)) {
      return label
    }
  }
  return ownWords(text)
}
