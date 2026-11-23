# Printing well

General FDM rules for Bambu P1-series printers, learned from failed prints. `design` is for parts being designed to print; `checklist`, `failures` and `lessons` are for slicing and sending.

## Pre-print checklist

1. **The check passes** with no ERROR, and every WARNING is read. Never force past a floating island. It reads the plate's G-code (arcs included): islands of extrusion with nothing under them, a part starting on one thin support trunk, missing brims, support pads without a brim, parts standing mostly on tree pads, first-layer temperatures below the material's (PLA 200, PETG 235, ASA 245, ABS 240, TPU 215 °C), bed temperatures out of range, and support settings (interface spacing not 0, supports on their own layer heights).
2. **Support-heavy parts get spares**: 1–2 extra copies. Never leave support inside small holes or slots (under about 5–6 mm): block them, or make them teardrops or D shapes.
3. **Brims stay on**: 5 mm on every part and every support base. Drop one only for a part with a big flat footprint whose fit a brim would spoil. Tiny ASA parts always get one.
4. **Support type fits the part**: normal supports (`support_type=normal(auto)`) for small, tilted or top-heavy parts, and for PETG and ASA. Supports print on the part's layers (`independent_support_layer_height=0`).
5. **No heavy island on one tree**: if a ball, head or arm end is its own island on a single trunk, lay the part down or split it.
6. **First layer suits the material**: PETG 245 °C, ASA 260, PLA 220 (set the first-layer temperature itself, not just the nozzle temperature). First-layer speed 30 mm/s for PETG and ASA, 35 for PLA, 30 for small figures.
7. **Re-check after any change**: a re-orientation, re-arrange, new support setting or re-slice resets this list. Auto-arrange rotates parts too.
8. **Full start routine (purge) after a filament swap, a jam or a failed first layer.** Make sure the spool turns freely.
9. **Paid parts and experiments never share a plate.**
10. **Watch the first layers** and any layer the check flagged.

## Failure patterns and default settings

| Situation | Do this |
|---|---|
| Small (under ~15 mm contact), tilted (30–60°) or top-heavy parts | Normal supports, 5 mm brim, supports on the part's layers. If a tip still floats, raise or re-orient the part |
| Big display figure with tall tree supports (PLA) | Trees are fine with a 5 mm brim around their bases and a 30–35 mm/s first layer |
| PETG | 240 °C, 245 °C first layer, bed 70, 30 mm/s first layer, 5 mm brim, normal supports for small parts, gyroid rather than grid under big tops. Scrape and alcohol-wipe the plate after a failure |
| ASA | An enclosed printer. On an open one: a box over it, bed 100, 260 °C, part fan 30–40% max and off for 3 layers, a brim on every part (8 mm on parts mostly on support), normal supports with the brim wrapping them. Let it cool covered |
| Tiny parts (letters, pegs, coupons) | 3–5 mm brim, at least 10 mm from other parts |
| Thin walls or printed threads that carry load | At least 2–3 mm walls in ASA; a steel bolt or insert instead of a printed stud |
| Sub-mm details (tassels, thin legs) | Thicken them; they soften and snap during support removal |
| After a jam, a swap or a failed first layer | Full start (purge), confirm extrusion on the first layers, make sure the part grows. Status stays RUNNING with no error |
| An old plate file | Re-slice from the STL with today's defaults rather than re-sending it. Thin support walls under a roof: normal supports and `support_expansion=1.5`, so they're wide and brimmed |
| Wi-Fi drop or reconnect | Re-check the printers and `timelapse list` (encode an unfinished frames folder); rerun a failed upload |

## Lessons

- **Large detailed figures (~100 mm):** 0.16 mm layers; 0.12 adds about 25% time for little gain. Variable layer height can't be set when slicing here, and on figures with flat areas at every height it saves almost nothing anyway. Print a matched pair at the same layer height.
- **PETG large flat tops** scuff and ripple: gyroid infill, top surface about 80 mm/s. High-flow PETG presets (long minimum layer time, short retraction, high flow) heat-soak small parts in ordinary PETG.
- **Banding and Z seams:** a minimum layer time that slows the outer wall makes a band. For PLA: part fan fixed at 100%, don't slow outer walls for cooling, a conditional scarf seam. For round or display parts: 60 mm/s outer walls, seam at the back, 0.16 layers (about 45% more time).
- **Bed type:** the Studio CLI defaults to the Cool Plate (bed 35 °C) unless the plate type is set. If a print comes loose, check the bed temperature first.
- **Bed leveling before every print:** a stale mesh gives inconsistent first layers after swaps.
- **Classic walls drop features thinner than a line width;** Arachne prints them. Thicken anything under 0.5 mm anyway.
- **Brims:** every brim 0 on small parts came loose.
- **Flat PLA/PETG: no brim, no skirt.** A PLA or PETG plate where every part sits on at least 1500 mm² of its own face (a 44 mm disc, a 39 mm square, body by body) and stands no taller than 1.5× that contact's side slices with neither: it doesn't warp or slip, and a brim only leaves artifacts on the bottom edge. ASA and ABS keep their brim, and so does a plate that also carries a part needing one (give flat parts their own plate). `brim` overrides.
- **TPU: no brim, no skirt** by default: TPU grips textured PEI on its own, and a TPU brim never comes off cleanly. Add one only for a tiny or tall, narrow footprint the check flags.
- **The start is trimmed** (no 100 mm purge, no vibration check: about 5 min a plate). print puts the purge back after a spool change, but can't tell a reload of the same spool: after a jam, slice with fullStart. `vibration` after moving a printer.
- **Filament swaps:** what a printer says it holds changes when the spool goes on, never ahead of the swap. When a print follows the swap, print with `loaded` sets it from the slice as the print starts; otherwise set_filament right after the swap. Never force past a type mismatch instead.
- **Big uploads over weak Wi-Fi** can take minutes, and the printer can take over 30 s to confirm the file. Rerunning is safe when a same-size copy is already on the card.
- **100% infill** needs a rectilinear pattern.
- **Supports cost a lot of time.** Before a big supported print, consider splitting the design (a flat plate plus bolt-on brackets).
- **Supports roughen what they touch,** but anything flat (75–90°) spanning more than a few mm needs them. The default threshold is 30°: only faces steeper than 60° get support.
- **Never assume a steep (60–90°) area will bridge:** every flagged area gets support unless the user says otherwise (`support_top_z_distance=0.32`, `support_object_xy_distance=0.6` for easy removal). To support only a small flat ledge, lower the threshold (`support_threshold_angle=15`, `support_top_z_distance=0.2`, `support_object_xy_distance=0.5`) and confirm where support landed in the G-code.
- **STLs made elsewhere are never print-ready as uploaded:** pick each part's bed face.

## Designing parts that print well

- **Fillet every junction where one feature rises off another** (2–3 mm fillet or cone at the root). Vertical features are joined by a single layer at their root and shear there.
- **Snap hooks print with their profile in the XY plane, and every feature in the piece starts on the bed.** Standing a hook part on its end keeps the bending along the extrusion lines, but a tower, fin or rib that starts partway up is a flat overhang whose support packs the gap between the hook walls and can't be cleaned out. Split the part across the print axis so each piece's features start on its bed face, and butt the pieces in a pocket or on keys. Taper a hook (thickness ∝ √(distance from the lip)), fillet its root at about 0.7× its thickness, and keep strain at or under 2%.
- **Re-check joints when scaling a design down:** fixed clearances don't shrink, so joining posts get far thinner than the scale says. Keep at least 2.5 mm, and turn narrow flat ceilings beside a wall into 45° slopes.
- **Split faces must self-align in both axes.** Key the face with a few truncated pyramids (45° flanks, about 2 mm tall, flat tops) near the corners, matching chamfered pockets on the other half, about 0.2 mm glue gap. Not a full checkerboard. Glue against the part's functional datum.
- **Never split on a flat plane, and never rely on small keys alone:** warp pulls shallow keys apart and leaves a bare glue line. Make the seam itself non-planar and load-bearing: a stepped lap, tongue and groove or fingers several mm deep, plus a doubler or splice block on the hidden side that overlaps several cm each side, notches around ribs and clamps the warp flat. Size the features to hold registration through about 1 mm of warp.
- **Never bridge a web in mid-air:** put thin webs flush with the bed face, and give overhangs a floor.
- **Holes printed on their side must be teardrops** (a 45° peak pointing +Z), or D holes; a round hole on its side sags undersize. Prefer the axis vertical. Ream after printing.
- **Clearance fits:** vertical holes print 0.1–0.2 mm under: 8.4 mm for an 8 mm shaft (running fit), 16.1 mm for a 16 mm bearing (press fit).
- **Check the part can be assembled,** not just that it doesn't collide assembled: anything threaded through two holes must be no wider than those holes between them.
- **Grooves for line or cable:** 90° V-grooves with a rounded root.
- **Ship a cleanup jig with support-heavy channels:** a small printed scraper that registers on the part and holds a blade at the right height. Better still, orient to need less support.
- **Don't overbuild jigs and fixtures:** a marking gauge is a thin channel, not a slab.
- When a design changes after parts are printed, say which printed parts are still usable.
