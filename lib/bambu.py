#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy"]
# ///
"""
bambu.py: the printers extension's slicing library. Slices STLs with the Bambu Studio CLI, reviews sliced plates, plans
a print against a printer's reported state, encodes timelapse frames and listens for printers on the LAN. Nothing here
connects to a printer: the extension holds every printer connection and runs this for the work that needs none.

  bambu.py slice OUT.gcode.3mf part.stl part2.stl:4 [--filament pla|petg|tpu|<preset>] [--brim 5] [--supports] ...
  bambu.py slice OUT.gcode.3mf base.stl+logo.stl@2 --color 000000 --color FFFFFF   two filaments (P1S + AMS)
  bambu.py info OUT.gcode.3mf       time, weight, bed temp, objects, plates (+ writes OUT.png top view)
  bambu.py check OUT.gcode.3mf      floating islands, brims, support pads and trunks, first-layer temps
  bambu.py soak OUT.gcode.3mf MIN   a bed heat soak
  bambu.py inspect part.stl         bed orientations and an overhang sheet
  bambu.py plan < request.json      a print's printer, AMS plan, loaded spool setting, purge and start command
  bambu.py encode FRAMES            a timelapse's frames folder -> .mp4 and a .jpg preview
  bambu.py discover                 printers broadcasting on the LAN, marked if configured

Printers are ID.env files in $PRINTERS_CONFIG (default ~/.config/bambu) with BAMBU_HOST and BAMBU_SERIAL; discover
reads only those two. Scratch work goes in $PRINTERS_WORK.
"""

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

CONFIG = Path(os.environ.get("PRINTERS_CONFIG") or Path.home() / ".config/bambu")
CACHE = Path(os.environ.get("PRINTERS_WORK") or Path(tempfile.gettempdir()) / "printers")
STUDIO = Path(os.environ.get("BAMBU_STUDIO", "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"))
PROFILES = STUDIO.parent.parent / "Resources/profiles/BBL"
MACHINES = {"p1p": "Bambu Lab P1P 0.4 nozzle", "p1s": "Bambu Lab P1S 0.4 nozzle",  # `slice --machine`
            "p2s": "Bambu Lab P2S 0.4 nozzle", "h2c": "Bambu Lab H2C 0.4 nozzle"}
NOZZLES = ("0.2", "0.4", "0.6", "0.8")  # `slice --nozzle`: the machine preset for that hotend ("Bambu Lab P2S 0.6 nozzle")
MACHINE = os.environ.get("BAMBU_MACHINE", MACHINES["p1p"])  # `slice --machine` switches it (use_machine)
MODEL = MACHINE.split()[2]  # "P1P"
NOZZLE = "0.4"
# Stock-only models: their slices use Bambu's machine and process presets as Bambu ships them, with every G-code
# routine untouched (start, leveling, the H2C's hotend-rack changes, AMS changes, end): no trimmed prime, no removed
# vibration check, no soak dwells written in. For the P2S and the H2C, which are calibrated on the printer.
STOCK_MODELS = {"P2S", "H2C"}
# Bambu names some P1S presets "@BBL P1S 0.4 nozzle" and shares the rest with the X1C, so {m} tries each in turn.
PRESET_MODELS = {"P1S": ["P1S", "P1S 0.4 nozzle", "X1C"]}
PROCESS_MODEL = {"P1S": "X1C"}  # "0.20mm Standard @BBL X1C" is the P1S's own default process
PLATES = {"textured": "Textured PEI Plate", "cool": "Cool Plate", "engineering": "Engineering Plate", "hot": "High Temp Plate"}
FILAMENTS = {  # alias -> preset names to try, in order ({m} = printer model)
    "pla": ["Generic PLA High Speed @BBL {m}", "Generic PLA @base"],
    "petg": ["Generic PETG HF @BBL {m}", "Generic PETG @base"],
    "tpu": ["Generic TPU @BBL {m}", "Generic TPU @base"],  # slow, safe for unknown TPU on an external spool
    "tpu95": ["Bambu TPU 95A HF @BBL {m}"], "tpu90": ["Bambu TPU 90A @BBL {m}"], "tpu85": ["Bambu TPU 85A @BBL {m}"],
    "abs": ["Generic ABS @BBL {m}", "Generic ABS @base"], "asa": ["Generic ASA @BBL {m}", "Generic ASA @base"],
}


# ================================================================== profiles


def load_preset(kind: str, name: str) -> dict:
    """A system preset merged over its `inherits` chain (child keys win)."""
    data = json.loads((PROFILES / kind / f"{name}.json").read_text())
    parent = data.pop("inherits", None)
    return {**(load_preset(kind, parent) if parent else {}), **data}


def machine_templates(name: str) -> dict:
    """Printer G-code (start, end, layer change...) lives in separate template files that the preset names in its
    `include` list (inherited: the H2C 0.6 preset uses the 0.4's), else '<name> template *.json' beside it."""
    included = load_preset("machine", name).get("include")
    if isinstance(included, str):
        included = json.loads(included.replace("'", '"'))
    paths = [PROFILES / "machine" / f"{n}.json" for n in included] if included else sorted((PROFILES / "machine").glob(f"{name} template *.json"))
    return {k: v for path in paths for k, v in json.loads(path.read_text()).items() if k not in ("name", "instantiation")}


def stock() -> bool:
    """Whether the current machine slices only with Bambu's own presets and G-code (STOCK_MODELS)."""
    return MODEL in STOCK_MODELS


FLUSH = ("M109 S250 ;set nozzle to common flush temp\nM106 P1 S0\nG92 E0\nG1 E50 F200\nM400\n"
         "M104 S[nozzle_temperature_initial_layer]\nG92 E0\nG1 E50 F200\nM400\nM106 P1 S255\nG92 E0\nG1 E5 F300\n")
SHORT_PRIME = "M109 S[nozzle_temperature_initial_layer] ; trimmed: 10 mm prime instead of the 100 mm flush\nM106 P1 S0\nG92 E0\nG1 E10 F200\nM400\nM106 P1 S255\n"
FAST_CHECK = re.compile(r";===== mech mode fast check=+\n.*?;===== fmech mode fast check=+\n", re.S)


def machine_profile(full_start: bool) -> dict:
    """Flattened machine preset. By default the start G-code skips the 100 mm purge and the vibration fast check
    (saves ~5 min per plate); `full_start` keeps Bambu's routine."""
    m = {**load_preset("machine", MACHINE), **machine_templates(MACHINE), "from": "system", "is_custom_defined": "0"}
    m.pop("include", None)
    if len(m.get("nozzle_diameter") or []) > 1 and not m.get("extruder_nozzle_stats"):
        # A two-extruder machine (the H2C) needs its nozzle inventory, which Studio's GUI syncs from the printer; its CLI
        # has none and refuses the plate ("No valid nozzle found"). One standard nozzle per extruder, as the GUI assumes
        # before a sync. Not G-code: the start, rack and AMS routines stay Bambu's.
        m["extruder_nozzle_stats"] = [f"{t}#1" for t in m.get("default_nozzle_volume_type") or ["Standard"] * len(m["nozzle_diameter"])]
    start = m["machine_start_gcode"]
    if not full_start and not stock():
        if start.count(FLUSH) == 1 and len(FAST_CHECK.findall(start)) == 1:
            m["machine_start_gcode"] = FAST_CHECK.sub(";===== vibration fast check removed =====\n", start.replace(FLUSH, SHORT_PRIME))
        else:
            print("note: this printer's start G-code didn't match the trim patterns; using Bambu's full start routine", file=sys.stderr)
    return m


def use_machine(name: str, nozzle: str | None = None):
    """Slices for printer model `name` (a MACHINES key) from here on, with a `nozzle` mm hotend (default 0.4)."""
    global MACHINE, MODEL, NOZZLE  # REVIEW: the slice target is process-wide; one CLI run slices for one machine
    machine = MACHINES[name] if not nozzle else MACHINES[name].replace(" 0.4 nozzle", f" {nozzle} nozzle")
    if not (PROFILES / "machine" / f"{machine}.json").exists():
        sys.exit(f"Bambu Studio has no {machine!r} preset (nozzles for {name}: "
                 + ", ".join(n for n in NOZZLES if (PROFILES / "machine" / f"{MACHINES[name].replace(' 0.4 nozzle', f' {n} nozzle')}.json").exists()) + ")")
    MACHINE, MODEL, NOZZLE = machine, machine.split()[2], nozzle or "0.4"


def preset_models() -> list[str]:
    """The model names presets for this machine are filed under, most specific first: "P2S 0.6 nozzle", then "P2S"."""
    base = PRESET_MODELS.get(MODEL, [MODEL])
    return [f"{MODEL} {NOZZLE} nozzle", *base] if NOZZLE != "0.4" else base


def default_process() -> str:
    """The process preset a slice starts from: Bambu's own default for the machine (its default_print_profile, e.g.
    "0.20mm Standard @BBL P2S", "0.30mm Standard @BBL H2C 0.6 nozzle"); the P1S's is filed under the X1C."""
    if stock() or NOZZLE != "0.4":
        return load_preset("machine", MACHINE)["default_print_profile"]
    return f"0.20mm Standard @BBL {PROCESS_MODEL.get(MODEL, MODEL)}"


def filament_profile(choice: str, overrides: list[str] | None = None) -> dict:
    """A filament preset by alias or exact name, for the current MACHINE, with KEY=VALUE overrides."""
    names = list(dict.fromkeys(n.format(m=m) for n in FILAMENTS.get(choice.lower(), [choice]) for m in preset_models()))
    for name in names:
        if (PROFILES / "filament" / f"{name}.json").exists():
            f = {**load_preset("filament", name), "from": "system", "is_custom_defined": "0"}
            if not f.get("compatible_printers") or MACHINE not in f["compatible_printers"]:
                f["compatible_printers"] = [MACHINE]  # base presets carry no printer list; the CLI rejects them otherwise
            for kv in overrides or []:
                k, v = kv.split("=", 1)
                f[k] = [v]  # filament values are per-extruder lists
            return f
    sys.exit(f"no filament preset found for {choice!r} (tried {names}); pass an exact preset name from {PROFILES / 'filament'}")


# Material defaults learned from failed prints; --fset/--set still win.
FILAMENT_DEFAULTS = {
    # The HF preset's 220 balled up. The rest undo its high-flow values for ordinary PETG: 16 mm³/s, 0.4 mm retraction,
    # 20-40% fan, and a 25 s layer time that crawls small parts at 10 mm/s under a 240 °C nozzle (heat soak, blobs).
    "PETG": {"nozzle_temperature": "240", "nozzle_temperature_initial_layer": "245", "filament_max_volumetric_speed": "11",
             "slow_down_layer_time": "10", "slow_down_min_speed": "15", "fan_min_speed": "30", "fan_max_speed": "60",
             "filament_retraction_length": "0.8"},
    "ASA": {"fan_max_speed": "35", "close_fan_the_first_x_layers": "3"},  # the profile's 80% fan curls ASA on an open-frame P1P
    # A printed ball: the P1P preset's fan swung 50-100% with layer time, and the 8 s minimum layer
    # time slowed the outer wall from 199 to 50 mm/s and back, which printed as a band. Fixed 100% fan (the P1S preset
    # already is) and outer walls never slowed for cooling; inner walls and infill still slow down.
    "PLA": {"fan_min_speed": "100", "fan_max_speed": "100", "no_slow_down_for_cooling_on_outwalls": "1"},
}
# Per alias: the `pla` alias loads Bambu's High Speed PLA preset (18 mm³/s), more than ordinary PLA melts on a P1 hotend
# (gloss bands, under-extrusion). 15 until the max-flow calibration says otherwise; RFID/exact presets keep their own.
ALIAS_DEFAULTS = {"pla": {"filament_max_volumetric_speed": "15"}}
FIRST_LAYER_SPEED = {"PLA": "35", "PETG": "30", "ASA": "30"}  # mm/s; PLA ran well at 35
# Every slice: Arachne keeps walls under one line width that classic drops (a cap's brim, 0.25-0.3 mm
# fins), and loops under 6.5 mm (pins, earphones) print at the preset's small-perimeter speed (50%).
PROCESS_DEFAULTS = {"wall_generator": "arachne", "min_feature_size": "25%", "min_bead_width": "85%", "small_perimeter_threshold": "6.5"}
# All-PLA plates (a printed ball): conditional scarf seam on the outer wall. It ramps the loop's
# start and end instead of one zit, and keeps a plain seam wherever a corner sharper than 155° can hide it.
PLA_PROCESS_DEFAULTS = {"override_filament_scarf_seam_setting": "1", "seam_slope_type": "external", "seam_slope_conditional": "1"}
# --cosmetic, for round, organic or display parts (a printed ball's reprint): 0.16 layers, the seam on the back (+Y),
# and slow walls at one speed (overhangs up to 50% print at the wall speed too), so the surface has no speed bands.
COSMETIC = {"seam_position": "back", "outer_wall_speed": "60", "overhang_2_4_speed": "60", "inner_wall_speed": "150"}
BIG_FOOTPRINT_MM = 80  # a part this long in X or Y gets the warp rule (big_footprint_settings)
# Flat-contact rule (a printed disc): a PLA or PETG part that sits on the bed over at least
# FLAT_CONTACT_MM2 of its own face (a 44 mm disc, a 39 mm square), and stands no taller than FLAT_HEIGHT_RATIO times that
# contact's side, neither warps nor slips, so a brim or skirt only leaves artifacts on its edge. Measured from the STL.
FLAT_CONTACT_MM2 = 1500
FLAT_HEIGHT_RATIO = 1.5
FLAT_MATERIALS = {"PLA", "PETG"}  # ASA/ABS lift however big the contact; TPU has its own no-brim rule
BRIM_TYPES = {"outer": "outer_only", "inner": "inner_only", "both": "outer_and_inner", "ears": "brim_ears", "auto": "auto_brim"}
EDGE_MM = 2  # --place's named spots keep a part's brim this far inside the bed's edge
SPOTS = {"center": (0, 0), "back": (0, 1), "front": (0, -1), "left": (-1, 0), "right": (1, 0),
         "back-left": (-1, 1), "back-right": (1, 1), "front-left": (-1, -1), "front-right": (1, -1)}  # +y is the back of the bed
NORMAL_SUPPORT_MATERIALS = {"PETG", "ASA", "ABS"}  # tree pads lift in these


def extents(obj: list[tuple[str, int]]) -> tuple[float, float]:
    """An object's X and Y extents (mm), from its STLs as they will sit on the bed (before any --orient)."""
    import numpy as np
    v = np.concatenate([read_stl(Path(path)).reshape(-1, 3) for path, _ in obj])
    w, d = (v.max(axis=0) - v.min(axis=0))[:2]
    return float(w), float(d)


def footprint_mm(obj: list[tuple[str, int]]) -> float:
    """The longer of an object's X and Y extents."""
    return max(extents(obj))


def bed_contacts(obj: list[tuple[str, int]]) -> list[tuple[float, float]]:
    """Each body's own contact with the bed (mm², its downward faces within 0.05 mm of the object's lowest point, as
    exported) and height (mm). An STL of several loose bodies (a set of caps) is judged body by body."""
    import numpy as np
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    tris = np.concatenate([read_stl(Path(path)) for path, _ in obj])
    _, vid = np.unique(np.round(tris.reshape(-1, 3), 4), axis=0, return_inverse=True)
    vid = vid.reshape(-1, 3)
    t = np.repeat(np.arange(len(tris)), 3)
    links = coo_matrix((np.ones(len(t)), (t, vid.ravel())))  # triangle-vertex incidence
    _, body = connected_components(links @ links.T, directed=False)
    z = tris[:, :, 2]
    low = float(z.min())
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    down = (z.max(axis=1) <= low + 0.05) & (n[:, 2] < 0)
    out = []
    for b in np.unique(body):
        here = body == b
        out.append((float(np.abs(n[here & down, 2]).sum() / 2), float(z[here].max() - z[here].min())))
    return out


def flat_contact(obj: list[tuple[str, int]]) -> bool:
    """Whether every body of an object that touches the bed sits flat on a big face of its own (the flat-contact rule).
    Bodies above the bed (an overlapping shell, a part on supports) don't count here; support pads they stand on make
    `slice` put the brim back after its check."""
    touching = [(area, height) for area, height in bed_contacts(obj) if area > 0]
    return bool(touching) and all(area >= FLAT_CONTACT_MM2 and height <= FLAT_HEIGHT_RATIO * area ** 0.5 for area, height in touching)


def big_footprint_settings(kind: str | None) -> list[str]:
    """Filament overrides for parts over BIG_FOOTPRINT_MM (the W rule; a big base lifted at a corner with the fan at
    90-100% from layer 6): fan off for 3 layers, ramped to full by layer 8, and no P1S aux fan blowing across PLA."""
    return ["close_fan_the_first_x_layers=3", "full_fan_speed_layer=8", *(["additional_cooling_fan_speed=0"] if kind == "PLA" else [])]


def support_settings(support_type: str, layer_height: str) -> dict:
    """Supports on the part's layers, smooth roofs (spacing 0, 3 top layers, ironed), a 0.16 mm top gap (one layer when
    layers are finer) and 0.5 mm side clearance (a printed ball: the 0.2 gap drooped and strung on
    the supported rim), and for normal supports the grid style, which starts every support as one wide pad on the bed."""
    return {"support_type": support_type, "independent_support_layer_height": "0", "support_interface_top_layers": "3",
            "support_interface_spacing": "0", "enable_support_ironing": "1",
            "support_top_z_distance": f"{min(float(layer_height), 0.16):g}", "support_object_xy_distance": "0.5",
            **({"support_style": "grid"} if support_type.startswith("normal") else {})}


def no_brim_default(kinds: list[str | None], flat: bool) -> bool:
    """Plates whose default is no brim and no skirt: TPU-only (TPU grips the PEI on its own, and a TPU brim or skirt
    never peels off cleanly: it stretches and leaves a ragged edge), and PLA/PETG plates where every part sits flat on a
    big face of its own (the flat-contact rule: nothing to warp or slip, and the brim only marks the edge)."""
    return bool(kinds) and (all(k == "TPU" for k in kinds) or (flat and all(k in FLAT_MATERIALS for k in kinds)))


def brim_width(args, kinds: list[str | None], big: bool, quiet: bool = True, flat: bool = False) -> float:
    """The plate's brim width (mm): --brim, else 5, or 8 with a part over BIG_FOOTPRINT_MM, or none where
    no_brim_default says so. ASA always gets at least 5."""
    brim = args.brim if args.brim is not None else 0.0 if no_brim_default(kinds, flat) else 8.0 if big else 5.0
    if "ASA" in kinds and brim < 5:
        if not quiet:
            print(f"note: ASA gets a brim of at least 5 mm on an open-frame printer; using 5 instead of {brim:g}", file=sys.stderr)
        brim = 5.0
    return brim


def brim_reach(args, kinds: list[str | None], big: bool, flat: bool = False) -> float:
    """How far the brim reaches out from a part's outside (mm): an inner-only brim reaches nowhere."""
    return 0.0 if args.brim_type == "inner" else brim_width(args, kinds, big, flat=flat)


def brim_settings(args, brim: float, efc: float) -> dict:
    """Brim type, width and gap. Bambu draws the brim around the part as modelled and then shrinks the part's first
    layer by its elephant-foot compensation (0.15 mm), so the gap printed is brim_object_gap plus that, on outer and
    inner brims alike: measured on the first-layer G-code of a cube and a tube, 0.23 mm at the defaults, 0.13 at
    brim_object_gap=0, and -0.03 (touching) only with the compensation off too. Bambu refuses a negative gap. So for
    --brim-gap the compensation gives way to a gap smaller than itself, and the gap printed is the gap asked."""
    if brim <= 0:
        return {"brim_type": "no_brim", "brim_width": "0", "brim_object_gap": "0.1"}
    p = {"brim_type": BRIM_TYPES[args.brim_type or "outer"], "brim_width": f"{brim:g}", "brim_object_gap": "0.1"}
    if args.brim_gap is not None:
        p.update({"brim_object_gap": f"{args.brim_gap - efc:g}"} if args.brim_gap >= efc else
                 {"brim_object_gap": "0", "elefant_foot_compensation": f"{args.brim_gap:g}"})
    return p


def process_profile(args, kinds: list[str | None], support_type: str = "tree(auto)", big: bool = False, flat: bool = False) -> dict:
    """Process settings: the preset, then PROCESS_DEFAULTS, the CLI options and material defaults (for every filament on
    the plate), then --set (which always wins). `big` (a part over BIG_FOOTPRINT_MM) makes the default brim 8 mm;
    a TPU-only plate, and a PLA/PETG plate whose parts are all `flat` (the flat-contact rule), get no brim and no skirt
    unless --brim asks for one."""
    p = {**load_preset("process", args.process or default_process()),
         "from": "system", "is_custom_defined": "0", "curr_bed_type": PLATES[args.plate], **PROCESS_DEFAULTS}
    if args.walls:
        p["wall_loops"] = str(args.walls)
    if args.infill is not None:
        p["sparse_infill_density"] = f"{args.infill}%"
        if args.infill >= 100:
            p["sparse_infill_pattern"] = "zig-zag"  # grid/gyroid/etc. are rejected at 100%; rectilinear is the solid pattern
    if args.cosmetic:
        p.update(COSMETIC, layer_height="0.16")
    if args.layer:
        p["layer_height"] = str(args.layer)
    if kinds and all(k == "PLA" for k in kinds):
        p.update(PLA_PROCESS_DEFAULTS)
    brim = brim_width(args, kinds, big, quiet=False, flat=flat)
    if no_brim_default(kinds, flat):
        p["skirt_loops"] = "0"
    p.update(brim_settings(args, brim, float(p.get("elefant_foot_compensation") or 0)))
    if speeds := [FIRST_LAYER_SPEED[k] for k in kinds if k in FIRST_LAYER_SPEED]:
        p["initial_layer_speed"] = min(speeds, key=float)
    if args.supports:
        p.update(enable_support="1", support_on_build_plate_only="1" if args.supports == "bed" else "0",
                 **support_settings(support_type, str(p.get("layer_height", "0.2"))))
    if args.support_filament:
        p["support_filament"] = str(args.support_filament)
    if args.support_interface_filament:
        p["support_interface_filament"] = str(args.support_interface_filament)
        if kinds[args.support_interface_filament - 1] != kinds[0]:  # a different material doesn't bond, so no z gap is needed
            p.update(support_top_z_distance="0", support_bottom_z_distance="0")
    if len(kinds) > 1:
        p["enable_prime_tower"] = "0" if args.no_prime_tower else "1"
    for kv in args.set or []:
        k, v = kv.split("=", 1)
        p[k] = v
    return p


# ================================================================== slicing


def parse_objects(parts: list[str]) -> list[list[tuple[str, int]]]:
    """One entry per object copy on the plate, each a list of its parts as (absolute STL path, filament number):
    'part.stl', 'part.stl:3' (or *3) for three copies, 'part.stl@2' on filament 2, and 'base.stl+logo.stl@2:4' for four
    copies of one object made of two parts that keep their positions relative to each other (the logo on filament 2)."""
    out = []
    for spec in parts:
        m = re.fullmatch(r"(.+?)[:*](\d+)(@\d+)?", spec)  # copies at the end ('part.stl:3@2' is read as 'part.stl@2:3')
        body, copies = (m[1] + (m[3] or ""), int(m[2])) if m else (spec, 1)
        obj = []
        for part in body.split("+"):
            pm = re.fullmatch(r"(.+?)(?:@(\d+))?", part)
            path = Path(pm[1]).expanduser().resolve()
            if not path.exists():
                sys.exit(f"missing {path}")
            if pm[2] and int(pm[2]) < 1:
                sys.exit(f"{part}: filaments are numbered from 1")
            obj.append((str(path), int(pm[2] or 1)))
        out += [obj] * copies
    return out


def write_project(objects: list[list[tuple[str, int]]], path: Path, places: list[tuple[float, float]] | None = None):
    """A Bambu Studio 3MF holding `objects` (from parse_objects): one object per copy, its parts as separate volumes
    at their STL positions, each part's filament in Metadata/model_settings.config. The Studio CLI takes per-part
    filaments only this way; STL inputs can carry one filament per object at most. With `places`, each object's
    footprint center goes at its (x, y) on the bed; without, Studio's arrange spreads them."""
    import numpy as np
    meshes, models, resources, items, config, plate = {}, {}, [], [], [], []
    ns = ('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
          'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"')
    head = f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" {ns} requiredextensions="p">\n'
    next_id = 1
    for n, obj in enumerate(objects, 1):
        for stl, _ in obj:
            if stl not in meshes:
                verts, tris = np.unique(read_stl(Path(stl)).reshape(-1, 3).round(5), axis=0, return_inverse=True)
                meshes[stl] = (verts, tris.reshape(-1, 3))
        everything = np.vstack([meshes[stl][0] for stl, _ in obj])
        lo, hi = everything.min(0), everything.max(0)
        origin = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])  # the object's own origin: bottom center
        file, parts, components = f"3D/Objects/object_{n}.model", [], []
        for stl, filament in obj:
            verts, tris = meshes[stl]
            body = "\n".join(f'     <vertex x="{x:.5f}" y="{y:.5f}" z="{z:.5f}"/>' for x, y, z in verts - origin)
            faces = "\n".join(f'     <triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
            parts.append(f'  <object id="{next_id}" type="model">\n   <mesh>\n    <vertices>\n{body}\n    </vertices>\n    <triangles>\n{faces}\n'
                         f'    </triangles>\n   </mesh>\n  </object>')
            components.append(f'    <component p:path="/{file}" objectid="{next_id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>')
            config.append((next_id, Path(stl).stem, filament))
            next_id += 1
        models[file] = head + " <resources>\n" + "\n".join(parts) + "\n </resources>\n <build/>\n</model>\n"
        oid, part_ids = next_id, config[-len(obj):]
        next_id += 1
        resources.append(f'  <object id="{oid}" type="model">\n   <components>\n' + "\n".join(components) + "\n   </components>\n  </object>")
        x, y = places[n - 1] if places else (128 + 3 * n, 128 + 3 * n)  # without places, arrange spreads them
        items.append(f'  <item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 {x:.3f} {y:.3f} 0" printable="1"/>')
        name = "+".join(stem for _, stem, _ in part_ids)
        plate.append(f'    <model_instance>\n      <metadata key="object_id" value="{oid}"/>\n      <metadata key="instance_id" value="0"/>\n'
                     f'      <metadata key="identify_id" value="{oid}"/>\n    </model_instance>')
        config[-len(obj):] = [(oid, name, obj[0][1], part_ids)]
    # No "Application: BambuStudio" metadata: with it the CLI takes this for one of its own projects, expects its full
    # settings inside and crashes (exit 139). Without it, it still reads the per-part filaments in model_settings.config.
    main = (head + ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
            " <resources>\n" + "\n".join(resources) + "\n </resources>\n <build>\n" + "\n".join(items) + "\n </build>\n</model>\n")
    settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + "".join(
        f'  <object id="{oid}">\n    <metadata key="name" value="{name}"/>\n    <metadata key="extruder" value="{first}"/>\n'
        + "".join(f'    <part id="{pid}" subtype="normal_part">\n      <metadata key="name" value="{stem}"/>\n'
                  f'      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <metadata key="extruder" value="{fil}"/>\n    </part>\n'
                  for pid, stem, fil in parts)
        + "  </object>\n" for oid, name, first, parts in config) + (
        '  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n'
        + "\n".join(plate) + "\n  </plate>\n</config>\n")
    rel = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                   ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
                   ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n')
        z.writestr("_rels/.rels", rel + ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n')
        z.writestr("3D/3dmodel.model", main)
        z.writestr("3D/_rels/3dmodel.model.rels", rel + "".join(
            f' <Relationship Target="/{f}" Id="rel-{i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
            for i, f in enumerate(models, 1)) + "</Relationships>\n")
        for f, text in models.items():
            z.writestr(f, text)
        z.writestr("Metadata/model_settings.config", settings)


def flush_volume(src: str, dst: str) -> float:
    """mm³ of purge going from filament color `src` to `dst` (RRGGBB), after Bambu Studio's FlushVolCalc (approximate):
    a light color after a dark one needs the most (black -> white ~670), dark after light little (white -> black ~190)."""
    import colorsys
    import math

    def look(hexcolor):
        r, g, b = (int(hexcolor.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4))
        h, sat, v = colorsys.rgb_to_hsv(r, g, b)
        return 0.3 * r + 0.59 * g + 0.11 * b, sat * math.cos(2 * math.pi * h), sat * math.sin(2 * math.pi * h), v
    (fl, fx, fy, fv), (tl, tx, ty, tv) = look(src), look(dst)
    hue = math.hypot(tx - fx, ty - fy)
    if tl >= fl:
        lumi = (tl - fl) ** 0.7 * 560
    else:
        lumi, hue = (fl - tl) * 80, min(hue, 0.67 * tv + 0.33 * fv)
    a, b = 230 * hue, lumi
    return min(max(math.sqrt(a * a + b * b + a * b), 60) + 107, 800)  # third side of a 120° triangle, as Studio does


def purge_settings(filaments: list[dict], explicit: list[bool], fixed: float | None) -> dict:
    """flush_volumes_matrix for the plate's filaments: --purge MM3 for every change, else from their colors. A filament
    whose color wasn't given gets the black-to-white purge into it, since what it really looks like isn't known."""
    colors = [f["filament_colour"][0] for f in filaments]
    worst = flush_volume("000000", "FFFFFF")
    vol = lambda i, j: 0 if i == j else fixed if fixed is not None else flush_volume(colors[i], colors[j]) if explicit[j] else worst  # noqa: E731
    n = len(filaments)
    return {"flush_volumes_matrix": [f"{vol(i, j):.0f}" for i in range(n) for j in range(n)], "flush_multiplier": ["1"]}


def points(values: list[str]) -> list[tuple[float, float]]:
    """['0x0', '256x0', ...] -> [(0.0, 0.0), (256.0, 0.0), ...]"""
    return [tuple(float(c) for c in v.split("x")) for v in values or []]


def bed(machine: dict | None = None) -> tuple[tuple[float, float, float, float], tuple[float, float, float, float] | None]:
    """The printable area and the no-go corner (Bambu's bed_exclude_area, the front-left 18 x 28 mm on the P1s) as boxes
    (x0, y0, x1, y1), in bed mm: (0, 0) is the front-left corner and +y the back, as Bambu Studio shows it."""
    m = machine or load_preset("machine", MACHINE)
    box = lambda pts: (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))  # noqa: E731
    area, exclude = points(m["printable_area"]), points(m.get("bed_exclude_area"))
    return box(area), (box(exclude) if exclude and box(exclude)[2] > box(exclude)[0] else None)


def overlap(a, b, gap: float = 0.0) -> bool:
    """Whether boxes a and b come closer than `gap`."""
    return a[0] < b[2] + gap and b[0] < a[2] + gap and a[1] < b[3] + gap and b[1] < a[3] + gap


def outline(obj: list[tuple[str, int]]):
    """An object's footprint as its convex hull in XY, around its footprint's center (the point --place puts)."""
    import numpy as np
    from scipy.spatial import ConvexHull
    v = np.concatenate([read_stl(Path(path)).reshape(-1, 3)[:, :2] for path, _ in obj])
    v = v - (v.min(0) + v.max(0)) / 2
    return v[ConvexHull(v).vertices]


def apart(a, b) -> float:
    """How far apart two convex polygons (N x 2) are at least: the widest gap along any of their edges' normals
    (negative when they overlap). Never more than the true distance."""
    import numpy as np
    best = -np.inf
    for poly in (a, b):
        edges = np.roll(poly, -1, axis=0) - poly
        normals = np.stack([edges[:, 1], -edges[:, 0]], 1)
        normals = normals[np.linalg.norm(normals, axis=1) > 1e-9]
        normals /= np.linalg.norm(normals, axis=1)[:, None]
        pa, pb = a @ normals.T, b @ normals.T
        best = max(best, float(np.max(np.maximum(pb.min(0) - pa.max(0), pa.min(0) - pb.max(0)))))
    return best


def grown(box, by: float):
    return (box[0] - by, box[1] - by, box[2] + by, box[3] + by)


def place_objects(spots: list[str], objects: list[list[tuple[str, int]]], reach: float) -> list[tuple[float, float]]:
    """Where each object's footprint center goes for --place, one spot per object in order: 'X,Y' in bed mm, or a named
    spot (SPOTS) that keeps its brim (`reach` mm out) EDGE_MM inside the bed's edges and clear of the no-go corner.
    Exits on a part off the bed, in the no-go corner, or within 1 mm of another; notes a brim the bed's edge or the
    no-go corner cuts (Bambu leaves the brim out of both)."""
    if len(spots) != len(objects):
        sys.exit(f"--place: this plate has {len(objects)} object(s) (copies count), so it needs {len(objects)} spot(s), one per object "
                 f"in order; got {len(spots)}")
    import numpy as np
    (bx0, by0, bx1, by1), exclude = bed()
    out, shapes = [], []
    for spot, obj in zip(spots, objects):
        name, (w, d), shape = "+".join(Path(p).stem for p, _ in obj), extents(obj), outline(obj)
        if m := re.fullmatch(r"\s*(-?\d+(?:\.\d*)?)\s*,\s*(-?\d+(?:\.\d*)?)\s*", spot):
            cx, cy = float(m[1]), float(m[2])
        elif spot.strip().lower() in SPOTS:
            sx, sy = SPOTS[spot.strip().lower()]
            e = reach + EDGE_MM
            cx = (bx0 + bx1) / 2 if sx == 0 else bx0 + e + w / 2 if sx < 0 else bx1 - e - w / 2
            cy = (by0 + by1) / 2 if sy == 0 else by0 + e + d / 2 if sy < 0 else by1 - e - d / 2
            brimmed = grown((cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2), reach)
            if exclude and overlap(brimmed, exclude):  # step right of the no-go corner or behind it, whichever is shorter
                dx, dy = exclude[2] + EDGE_MM - brimmed[0], exclude[3] + EDGE_MM - brimmed[1]
                cx, cy = (cx + dx, cy) if dx <= dy else (cx, cy + dy)
        else:
            sys.exit(f"--place {spot!r}: give X,Y in mm (0,0 is the front-left corner, +y the back) or one of {', '.join(SPOTS)}")
        box = (cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2)
        at = f"{name} ({w:.0f} x {d:.0f} mm) at {spot.strip()} would sit at x {box[0]:.1f}-{box[2]:.1f} y {box[1]:.1f}-{box[3]:.1f}"
        if box[0] < bx0 or box[1] < by0 or box[2] > bx1 or box[3] > by1:
            sys.exit(f"--place: {at}, off the {bx1 - bx0:g} x {by1 - by0:g} mm bed")
        shape = shape + (cx, cy)
        no_go = exclude and apart(shape, np.array([exclude[:2], (exclude[2], exclude[1]), exclude[2:], (exclude[0], exclude[3])]))
        if exclude and no_go < 0:
            sys.exit(f"--place: {at}, in the bed's no-go corner (x {exclude[0]:g}-{exclude[2]:g} y {exclude[1]:g}-{exclude[3]:g})")
        if exclude and no_go < reach:
            print(f"note: {at}, so its {reach:g} mm brim runs into the bed's no-go corner (x {exclude[0]:g}-{exclude[2]:g} "
                  f"y {exclude[1]:g}-{exclude[3]:g}), where Bambu leaves the brim out", file=sys.stderr)
        clash = next((i for i, other in enumerate(shapes) if apart(shape, other) < 1.0), None)
        if clash is not None:
            sys.exit(f"--place: {at}, within 1 mm of object {clash + 1}")
        if reach and not (bx0 <= box[0] - reach and by0 <= box[1] - reach and box[2] + reach <= bx1 and box[3] + reach <= by1):
            print(f"note: {at}, so the bed's edge cuts its {reach:g} mm brim there", file=sys.stderr)
        out.append((cx, cy))
        shapes.append(shape)
    return out


def shrunk_bed(machine: dict, by: float) -> dict:
    """The machine profile with its printable area shrunk by `by` mm on every side and its no-go corner grown to match,
    for arranging only."""
    (x0, y0, x1, y1), exclude = bed(machine)
    m = {**machine, "printable_area": [f"{x:g}x{y:g}" for x, y in ((x0 + by, y0 + by), (x1 - by, y0 + by), (x1 - by, y1 - by), (x0 + by, y1 - by))]}
    if exclude:
        ex1, ey1 = exclude[2] + by, exclude[3] + by
        m["bed_exclude_area"] = [f"{x:g}x{y:g}" for x, y in ((x0, y0), (ex1, y0), (ex1, ey1), (x0, ey1))]
    return m


def on_plate_one(project: Path) -> int:
    """How many objects a Studio project (unsliced 3MF) puts on plate 1."""
    with zipfile.ZipFile(project) as z:
        cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
    for plate in cfg.iter("plate"):
        if any(m.get("key") == "plater_id" and m.get("value") == "1" for m in plate.findall("metadata")):
            return len(plate.findall("model_instance"))
    return 0


def run_slicer(objects: list[list[tuple[str, int]]], out: Path, process: dict, filaments: list[dict], full_start: bool, orient: bool,
               places: list[tuple[float, float]] | None = None, reach: float = 0.0):
    """One Bambu Studio CLI slice of `objects` (from parse_objects) onto plate 1, written to `out`. One filament and
    single-part objects go in as STLs; otherwise as a 3MF (write_project) with every filament's settings. With `places`
    (place_objects) each object goes exactly there. Otherwise Studio arranges them, first on a bed shrunk by `reach`
    (how far the brim reaches out): its arrange sets parts about 1 mm from the bed's edge without counting their brim,
    and the edge then cuts it (four of six ASA rings on a plate kept 1.2 mm of their 8 mm brim on the edge side, and
    rings warped). The arranged project is then sliced on the whole bed. When they don't all fit that way, they're
    arranged on the whole bed as before, with a note."""
    CACHE.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="slice-", dir=CACHE))  # own dir per run: parallel slices sharing a dir clobber each other
    machine = machine_profile(full_start)
    for name, data in (("machine", machine), ("process", process), ("shrunk", shrunk_bed(machine, reach))):
        (work / f"{name}.json").write_text(json.dumps(data))
    for n, f in enumerate(filaments, 1):
        (work / f"filament{n}.json").write_text(json.dumps(f))
    if not places and len(filaments) == 1 and all(len(obj) == 1 for obj in objects):
        inputs = [obj[0][0] for obj in objects]
    else:
        write_project(objects, work / "plate.3mf", places)
        inputs = [str(work / "plate.3mf")]
    fils = ["--load-filaments", ";".join(f"{work}/filament{n}.json" for n in range(1, len(filaments) + 1))]
    arrange = "0" if places else "1"
    if not places and reach > 0:
        subprocess.run([str(STUDIO), "--orient", "1" if orient else "0", "--arrange", "1", "--load-settings", f"{work}/shrunk.json;{work}/process.json",
                        *fils, "--outputdir", str(work), "--export-3mf", "arranged.3mf", *inputs], capture_output=True, text=True)
        arranged = work / "arranged.3mf"
        if arranged.exists() and on_plate_one(arranged) == len(objects):
            inputs, arrange, orient = [str(arranged)], "0", False
        else:
            print(f"note: these parts don't all fit on one plate with their {reach:g} mm brim clear of the bed's edge, so they're arranged "
                  "on the whole bed and the edge may cut a brim (check says where); fewer per plate, or --place, keeps every brim whole",
                  file=sys.stderr)
    cmd = [str(STUDIO), "--orient", "1" if orient else "0", "--arrange", arrange, "--load-settings", f"{work}/machine.json;{work}/process.json",
           *fils, "--slice", "0", "--outputdir", str(work), "--export-3mf", "out.gcode.3mf", *inputs]
    log = subprocess.run(cmd, capture_output=True, text=True)
    result = work / "out.gcode.3mf"
    if not result.exists():
        errors = [line for line in (log.stdout + log.stderr).splitlines() if "error" in line.lower()]
        sys.exit("slicing failed:\n" + "\n".join(errors[-6:]) + f"\n(full log kept in {work})")
    shutil.move(result, out)
    shutil.rmtree(work, ignore_errors=True)


def hex_color(text: str) -> str:
    """argparse type: 'FFFFFF' or '#ffffff' -> 'FFFFFF'."""
    if not re.fullmatch(r"#?[0-9a-fA-F]{6}", text):
        raise argparse.ArgumentTypeError("a color is 6 hex digits, like FFFFFF")
    return text.lstrip("#").upper()


def slice_filaments(args, count: int, big: bool = False) -> tuple[list[dict], list[bool]]:
    """The settings for filaments 1..count: --filament and --color give them in order (the last --filament repeats),
    with the material and alias defaults (plus the big-footprint fan rule when `big`), then --fset on every one. Also
    which colors were given."""
    choices, colors, out = args.filament or ["pla"], args.color or [], []
    for i in range(count):
        choice = choices[min(i, len(choices) - 1)]
        kind = material(filament_profile(choice)["filament_type"][0])
        defaults = {**FILAMENT_DEFAULTS.get(kind, {}), **ALIAS_DEFAULTS.get(choice.lower(), {})}
        color = [f"filament_colour=#{colors[i]}"] if i < len(colors) else []
        out.append(filament_profile(choice, [f"{k}={v}" for k, v in defaults.items()] + (big_footprint_settings(kind) if big else [])
                                    + color + (args.fset or [])))
    return out, [i < len(colors) for i in range(count)]


def slice_cmd(args) -> None:
    """Slice with the material defaults, then run `check`. A tree-support slice with floating islands gets one
    automatic re-slice on normal supports (unless support_type was set by hand with --set). More than one filament
    (part.stl@2, --support-interface-filament 2, ...) slices for the P1S and its AMS unless --machine says otherwise."""
    objects = parse_objects(args.parts)
    used = {f for obj in objects for _, f in obj} | {n for n in (args.support_filament, args.support_interface_filament) if n}
    count = max([*used, len(args.filament or []), len(args.color or [])])
    if (args.support_filament or args.support_interface_filament) and not args.supports:
        sys.exit("--support-filament/--support-interface-filament need supports; add --supports")
    if args.place and args.orient:
        sys.exit("--place puts parts as exported; drop --orient (auto-orienting changes their footprint)")
    if args.brim == 0 and (args.brim_gap is not None or args.brim_type):
        sys.exit("--brim-gap and --brim-type need a brim; drop --brim 0")
    if args.brim_gap is not None and args.brim_gap < 0:
        sys.exit("--brim-gap can't be negative (0 fuses the brim to the part)")
    use_machine(args.machine or ("p1s" if count > 1 else "p1p"), args.nozzle)
    if stock() and args.soak:
        sys.exit(f"the {MODEL} slices with Bambu's own G-code only, so no soak is written in; drop --soak")
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    big = [obj[0][0] for obj in objects if footprint_mm(obj) > BIG_FOOTPRINT_MM]
    filaments, explicit = slice_filaments(args, count, bool(big))
    kinds = [material(f["filament_type"][0]) for f in filaments]
    # The flat-contact rule reads each part's contact as exported, so it waits out --orient (which turns parts after).
    flat = args.brim is None and not args.orient and bool(kinds) and all(k in FLAT_MATERIALS for k in kinds) \
        and all(flat_contact(obj) for obj in objects)
    if not flat and args.brim is None and not args.orient and kinds and all(k in FLAT_MATERIALS for k in kinds) \
            and (flats := [Path(obj[0][0]).name for obj in objects if flat_contact(obj)]):
        print(f"note: {', '.join(flats)} sit{'s' if len(flats) == 1 else ''} flat enough for no brim, but other parts on this plate need "
              "one, so the whole plate gets it; slice the flat parts on a plate of their own to keep their edges clean", file=sys.stderr)
    if flat:
        print(f"note: every part sits flat on at least {FLAT_CONTACT_MM2} mm² of its own, so this {'/'.join(dict.fromkeys(kinds))} "
              "plate gets no brim and no skirt (the flat-contact rule; --brim puts one back)", file=sys.stderr)
    if big:
        print(f"note: {Path(big[0]).name} is over {BIG_FOOTPRINT_MM} mm across, so this plate gets the warp rule: "
              f"{'an 8 mm brim, ' if args.brim is None and not flat else ''}part fan off for 3 layers and full only by layer 8, no P1S aux fan on PLA",
              file=sys.stderr)
    if count > 1 and len(set(kinds)) > 1 and not any(kv.startswith("support_interface") for kv in args.set or []):
        print(f"note: mixing {', '.join(k or '?' for k in dict.fromkeys(kinds))} on one plate; the slicer may refuse temperatures that far apart",
              file=sys.stderr)
    bodies = {f for obj in objects for _, f in obj} | {args.support_filament or 1}  # an interface-only material doesn't pick the support type
    support_type = "normal(auto)" if NORMAL_SUPPORT_MATERIALS & {kinds[f - 1] for f in bodies} else "tree(auto)"
    purge = purge_settings(filaments, explicit, args.purge) if count > 1 else {}
    if count > 1 and not all(explicit) and args.purge is None:
        print("note: no --color for some filaments, so changes into them purge the black-to-white amount; pass --color per filament "
              "(in order) to purge less", file=sys.stderr)
    profile = lambda kind: {**process_profile(args, kinds, kind, bool(big), flat), **purge}  # noqa: E731
    reach = brim_reach(args, kinds, bool(big), flat)
    places = place_objects(args.place, objects, reach) if args.place else None

    def sliced(support: str) -> None:
        run_slicer(objects, out, profile(support), filaments, args.full_start, args.orient, places, reach)
        if args.soak:
            soak_plate(out, args.soak)
        info(out, expected=len(objects))

    sliced(support_type)
    result = report_check(out)
    hand_set = any(kv.startswith("support_type=") for kv in args.set or [])
    if result["tree_floating"] and not hand_set:
        print("tree supports left islands in mid-air on this plate; re-slicing with normal supports", flush=True)
        support_type = "normal(auto)"
        sliced(support_type)
        result = report_check(out)
    if flat and result["wants_brim"]:  # support pads on the bed still need the brim that wraps them
        print("the flat parts' support pads need a brim on the bed; re-slicing with the default brim", flush=True)
        flat = False
        reach = brim_reach(args, kinds, bool(big))
        sliced(support_type)
        report_check(out)


def placements(z: zipfile.ZipFile) -> list[dict]:
    """Where each object sits on the bed in a Studio 3MF: its name and its footprint's center (x, y in bed mm), the
    spot `slice --place X,Y` takes."""
    names = {}
    if "Metadata/model_settings.config" in z.namelist():
        for o in ET.fromstring(z.read("Metadata/model_settings.config")).iter("object"):
            names[o.get("id")] = next((m.get("value") for m in o.findall("metadata") if m.get("key") == "name"), None)
    out = []
    for m in re.finditer(r'<item objectid="(\d+)"[^>]*?transform="([^"]+)"', z.read("3D/3dmodel.model").decode(errors="ignore")):
        t = [float(v) for v in m[2].split()]
        out.append({"name": (names.get(m[1]) or f"object {m[1]}").removesuffix(".stl"), "x": round(t[9], 2), "y": round(t[10], 2)})
    return out


def info(path: Path, expected: int | None = None) -> dict:
    """Summary of a sliced .gcode.3mf; also writes the slicer's top-down plate view next to it."""
    with zipfile.ZipFile(path) as z:
        at = placements(z)
        plates = sorted(n for n in z.namelist() if re.fullmatch(r"Metadata/plate_\d+\.gcode", n))
        head = z.read(plates[0]).decode(errors="ignore")[:200_000]
        objects = len(re.findall(r"<object ", z.read("Metadata/slice_info.config").decode()))
        if "Metadata/top_1.png" in z.namelist():
            path.with_suffix("").with_suffix(".png").write_bytes(z.read("Metadata/top_1.png"))
    grab = lambda pat: (m[1].strip() if (m := re.search(pat, head)) else "?")  # noqa: E731
    grams = [float(g) for g in re.findall(r"[\d.]+", grab(r"total filament weight \[g\] : ([\d.,]+)"))]
    summary = {"file": path.name, "time": grab(r"total estimated time: ([^;\n]+)"), "filament_g": f"{sum(grams):.2f}" if grams else "?",
               **({"filament_g_each": [f"{g:.2f}" for g in grams], "colors": grab(r"; filament_colour = ([^\n]+)"),
                   "printer_model": grab(r"; printer_model = ([^\n]+)")} if len(grams) > 1 else {}),
               "layers": grab(r"total layer number: (\d+)"), "filament": grab(r"; filament_type = ([^\n]+)"), "plate": grab(r"; curr_bed_type = ([^\n]+)"),
               "bed_C": grab(r"\n[ \t]*M140 S(\d+)"), **({"soak_min": soak} if (soak := soaked_minutes(head)) else {}),
               "nozzle_C": grab(r"; nozzle_temperature = (\d+)"),
               "objects_on_plate_1": objects, "placed": [f"{o['name']} at {o['x']:g},{o['y']:g}" for o in at], "plates": len(plates),
               "preview": str(path.with_suffix("").with_suffix(".png"))}
    print(json.dumps(summary, indent=1))
    if len(plates) > 1 or (expected and objects < expected):
        print(f"WARNING: not everything fit on one plate ({objects} of {expected or '?'} objects on plate 1, {len(plates)} plates). "
              "Only plate 1 prints; split the job.", file=sys.stderr)
    return summary


# ================================================================== heat soak
# ASA and ABS warp less when the bed, and the enclosure's air, have had time to come to temperature before the first
# layer. A soak holds the bed at its first-layer temperature for whole minutes right after the start G-code's bed-wait
# (M190), before the nozzle heats and the bed is leveled, as one-minute G4 dwells (a stop still lands within a minute).
# The plate is repacked with its G-code checksum, and the printer's countdown (M73 before the soak), the header's total
# and slice_info's prediction all count the soak. Soaking again replaces the old soak; 0 minutes takes it out.

SOAK_BLOCK = re.compile(r"; HEAT_SOAK_START (\d+) min\n.*?; HEAT_SOAK_END\n", re.S)
MAX_SOAK_MIN = 120
TOTAL_TIME = re.compile(r"(total estimated time: )([^;\n]+)")


def soaked_minutes(gcode: str) -> int:
    """The soak already in a plate's G-code, in minutes (0 for none)."""
    return int(m[1]) if (m := SOAK_BLOCK.search(gcode)) else 0


def dhms_seconds(text: str) -> int:
    """A time as Bambu writes it in the G-code header (2h 38m 8s) in seconds."""
    return sum(int(v) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u] for v, u in re.findall(r"(\d+)\s*([dhms])", text))


def dhms(seconds: int) -> str:
    """Seconds as Bambu writes a time in the G-code header: 2h 38m 8s."""
    d, s = divmod(max(0, int(seconds)), 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return " ".join(f"{v}{u}" for v, u in ((d, "d"), (h, "h"), (m, "m"), (s, "s")) if v) or "0s"


def soak_gcode(gcode: str, minutes: int) -> str:
    """The plate's G-code with a `minutes` soak after its bed-wait (any old soak replaced; 0 for none), and its
    countdown and header total moved by the difference."""
    delta = minutes - soaked_minutes(gcode)
    gcode = SOAK_BLOCK.sub("", gcode, count=1)
    end = gcode.find("; MACHINE_START_GCODE_END")
    wait = next((m for m in re.finditer(r"^M190 S(\d+)[^\n]*\n", gcode[: end if end >= 0 else len(gcode)], re.M) if int(m[1]) > 0), None)
    if not wait:
        sys.exit("no bed-wait (M190 with a temperature) in this plate's start G-code to soak after")
    block = (f"; HEAT_SOAK_START {minutes} min\n; the bed holds {wait[1]} C for {minutes} min before leveling and the first layer\n"
             + "G4 S60\n" * minutes + "; HEAT_SOAK_END\n") if minutes else ""
    before = re.sub(r"^(M73 P\d+ R)(\d+)", lambda m: f"{m[1]}{max(0, int(m[2]) + delta)}", gcode[: wait.end()], flags=re.M)
    before = TOTAL_TIME.sub(lambda m: m[1] + dhms(dhms_seconds(m[2]) + delta * 60), before, count=1)
    return before + block + gcode[wait.end():]


def soak_plate(path: Path, minutes: int, out: Path | None = None) -> tuple[int, int]:
    """Soaks every plate in a sliced .gcode.3mf for `minutes` (see soak_gcode) and writes it to out (default: in place),
    each G-code's .md5 and slice_info's predictions kept true. Answers (minutes before, bed temperature)."""
    if not 0 <= minutes <= MAX_SOAK_MIN:
        sys.exit(f"a soak is 0 to {MAX_SOAK_MIN} minutes")
    out = out or path
    if (model := sliced_model(path)) in STOCK_MODELS:
        sys.exit(f"{path.name} is sliced for the {model}, which runs Bambu's own G-code only; no soak is written in")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        plates = [n for n in names if re.fullmatch(r"Metadata/plate_\d+\.gcode", n)]
        if not plates:
            sys.exit(f"{path.name} has no sliced plate in it")
        changed, was, bed = {}, 0, 0
        for name in plates:
            gcode = z.read(name).decode()
            was = soaked_minutes(gcode)
            new = soak_gcode(gcode, minutes).encode()
            bed = int(re.search(r"^M190 S(\d+)", new.decode(), re.M)[1])
            changed[name], changed[name + ".md5"] = new, hashlib.md5(new).hexdigest().upper().encode()
        if "Metadata/slice_info.config" in names:
            config = z.read("Metadata/slice_info.config").decode()
            changed["Metadata/slice_info.config"] = re.sub(
                r'(key="prediction" value=")(\d+)', lambda m: f"{m[1]}{max(0, int(m[2]) + (minutes - was) * 60)}", config).encode()
        tmp = out.with_name(f".{out.name}.soak")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dest:
            for item in z.infolist():
                dest.writestr(item, changed.get(item.filename) or z.read(item))
    os.replace(tmp, out)
    return was, bed


def soak_cmd(args) -> None:
    path = Path(args.file).expanduser().resolve()
    out = Path(args.out).expanduser().resolve() if args.out else path
    was, bed = soak_plate(path, args.minutes, out)
    print(f"{out.name}: " + (f"the bed holds {bed} C for {args.minutes} min after it heats" if args.minutes else "no heat soak")
          + (f" (was {was} min)" if was else ""))
    info(out)


# ================================================================== check (pre-print slice review)
# Reads the plate G-code the printer will run and looks for what failed real prints: extrusions that start in
# mid-air, small footprints without a brim, parts standing on tree-support pads, and first-layer settings that
# don't suit the material. The extension's print runs it first and refuses on errors unless forced.

CHECK_RES = 0.2  # mm per raster pixel
MIN_ISLAND_MM2 = 0.5  # smaller floating specks are ignored
LOOKBACK_MM = 0.5  # how far above the last thing below it an island may start (covers support top/bottom z gaps)
SMALL_FOOTPRINT_MM2 = 50  # a footprint (part plus its support pad) under this wants a brim
TREE_PAD_SHARE = 0.3  # a part whose own bed contact is under this share of its footprint stands on its supports
PERCHED_MIN_MM2 = 1  # a part island at least this big that starts on supports only (above z 3 mm) gets its trunk checked
THIN_TRUNK_MM2 = 30  # supports under such an island totalling less than this halfway down are a thin trunk...
HEAVY_MM2 = 200  # ...if 15 mm higher the island, still on its own, has grown to this cross-section
FIRST_LAYER_MIN_C = {"PETG": 235, "PLA": 200, "ASA": 245, "ABS": 240, "TPU": 215}  # first-layer nozzle floor per material
BED_RANGE_C = {"PETG": (65, 85), "PLA": (45, 70), "ASA": (90, 110), "ABS": (90, 110), "TPU": (30, 50)}
INSTALLED_PLATE = "Textured PEI Plate"  # the plate the printers carry
PLATE_TEMP_KEYS = {"Textured PEI Plate": "textured_plate_temp", "Cool Plate": "cool_plate_temp",
                   "Engineering Plate": "eng_plate_temp", "High Temp Plate": "hot_plate_temp"}


def gcode_config(gcode: str) -> dict[str, str]:
    """The slicer's settings block at the top of the G-code ('; key = value'); multi-filament values keep only the first."""
    block = gcode[: gcode.find("; CONFIG_BLOCK_END")]
    return {m[1]: m[2].split(",")[0].strip().strip('"') for m in re.finditer(r"^; (\w+) = (.*)$", block, re.M)}


def object_names(path: Path) -> dict[int, str]:
    """G-code object label id -> the STL name it came from (from the 3mf's slice_info.config)."""
    with zipfile.ZipFile(path) as z:
        info = z.read("Metadata/slice_info.config").decode(errors="ignore") if "Metadata/slice_info.config" in z.namelist() else ""
    return {int(m[1]): m[2].removesuffix(".stl") for m in re.finditer(r'identify_id="(\d+)" name="([^"]*)"', info)}


def arc_points(x, y, nx, ny, i, j, clockwise: bool) -> list[tuple[float, float]]:
    """Points along a G2/G3 arc (center at x+i, y+j) every ~0.3 mm, ending at (nx, ny). A full circle has nx, ny == x, y."""
    import math
    cx, cy = x + i, y + j
    r = math.hypot(i, j)
    a0, a1 = math.atan2(y - cy, x - cx), math.atan2(ny - cy, nx - cx)
    sweep = a1 - a0
    if clockwise and sweep >= 0:
        sweep -= 2 * math.pi
    elif not clockwise and sweep <= 0:
        sweep += 2 * math.pi
    n = max(1, math.ceil(abs(sweep) * r / 0.3))
    return [(cx + r * math.cos(a0 + sweep * k / n), cy + r * math.sin(a0 + sweep * k / n)) for k in range(1, n)] + [(nx, ny)]


def read_layers(gcode: str) -> list[dict]:
    """Extruding paths per layer: [{z, height, strokes: [(feature, width_mm, object_id, [(x, y), ...])]}].
    Travel, wipe (negative E) and retraction moves are dropped; consecutive extruding moves join one polyline.
    Arcs are followed, not cut short: tree-support branches are mostly G2/G3 circles."""
    layers, feature, width, obj, x, y, relative = [], "", 0.42, None, 0.0, 0.0, False
    stroke = None  # polyline being extended, while moves keep extruding from where it ended
    for line in gcode.splitlines():
        head = line[:3]
        if head in ("G1 ", "G0 ", "G2 ", "G3 "):
            words = {w[0]: float(w[1:]) for w in line.split(";")[0].split()[1:] if w[0] in "XYEIJ" and len(w) > 1}
            nx = x + words.get("X", 0) if relative else words.get("X", x)
            ny = y + words.get("Y", 0) if relative else words.get("Y", y)
            arc = head[1] in "23" and ("I" in words or "J" in words)
            if layers and feature != "Custom" and words.get("E", 0) > 0 and ((nx, ny) != (x, y) or arc):
                pts = arc_points(x, y, nx, ny, words.get("I", 0), words.get("J", 0), head[1] == "2") if arc else [(nx, ny)]
                if stroke is None:
                    stroke = [(x, y)]
                    layers[-1]["strokes"].append((feature, width, obj, stroke))
                stroke += pts
            else:
                stroke = None
            x, y = nx, ny
        elif line.startswith("; FEATURE: "):
            feature, stroke = line[11:].strip(), None
        elif line.startswith("; LINE_WIDTH: "):
            width, stroke = float(line[14:]), None
        elif line.startswith("; CHANGE_LAYER"):
            layers.append({"z": 0.0, "height": 0.0, "strokes": []})
            stroke = None
        elif line.startswith("; Z_HEIGHT: ") and layers:
            layers[-1]["z"] = float(line[12:])
        elif line.startswith("; LAYER_HEIGHT: ") and layers:  # repeated mid-layer for thick bridges and independent support layers
            layers[-1]["height"] = max(layers[-1]["height"], float(line[16:]))
        elif line.startswith("; start printing object, unique label id: "):
            obj, stroke = int(line.rsplit(":", 1)[1]), None
        elif line.startswith("; stop printing object"):
            obj, stroke = None, None
        elif head == "G91":
            relative = True
        elif head == "G90":
            relative = False
    return layers


class Raster:
    """A 0.2 mm grid over the area the plate extrudes in. `draw` paints strokes as label indexes (0 = empty) and
    `labels` maps an index back to what it stands for (a feature name by default)."""

    def __init__(self, layers: list[dict]):
        import numpy as np
        pts = np.array([p for layer in layers for s in layer["strokes"] for p in (s[3][0], s[3][-1])] or [(0.0, 0.0)])
        self.x0, self.y0 = pts.min(0) - 3
        self.w, self.h = (np.ceil((pts.max(0) + 3 - (self.x0, self.y0)) / CHECK_RES).astype(int) + 1).tolist()
        self.labels: list = []

    def draw(self, strokes, key=lambda s: s[0]):
        import numpy as np
        from PIL import Image, ImageDraw
        img = Image.new("L", (self.w, self.h))
        d = ImageDraw.Draw(img)
        for s in strokes:
            label = key(s)
            if label not in self.labels:
                self.labels.append(label)
            px = [((x - self.x0) / CHECK_RES, (y - self.y0) / CHECK_RES) for x, y in s[3]]
            d.line(px, fill=self.labels.index(label) + 1, width=max(1, round(s[1] / CHECK_RES)), joint="curve")
        return np.asarray(img)

    def names(self, img, where) -> list:
        """The labels painted on `img` where the boolean mask `where` is set."""
        import numpy as np
        return sorted({self.labels[i - 1] for i in np.unique(img[where]) if i}, key=str)

    def box(self, sl) -> tuple[float, float, float, float]:
        """mm bounding box (x0, y0, x1, y1) of a (rows, cols) slice."""
        ys, xs = sl
        return (self.x0 + xs.start * CHECK_RES, self.y0 + ys.start * CHECK_RES, self.x0 + xs.stop * CHECK_RES, self.y0 + ys.stop * CHECK_RES)


def grow(mask):
    """`mask` dilated by one pixel in all 8 directions (much faster than ndimage.binary_dilation on the whole plate)."""
    rows = mask.copy()
    rows[1:] |= mask[:-1]
    rows[:-1] |= mask[1:]
    out = rows.copy()
    out[:, 1:] |= rows[:, :-1]
    out[:, :-1] |= rows[:, 1:]
    return out


def is_support(label) -> bool:
    return isinstance(label, str) and label.startswith("Support")


def floating_islands(layers: list[dict], raster: Raster, max_z: float | None = None) -> tuple[list[dict], list[dict]]:
    """Walks the layers and returns two lists of islands (layer, z, box (mm), area_mm2, features, objects):
    floating: connected extrusion with nothing under it, no overlap with anything extruded up to LOOKBACK_MM below its
      layer (the first layer sits on the bed);
    perched: part islands (not support) above z 3 mm that rest only on supports, for `thin_trunks`."""
    import numpy as np
    from scipy import ndimage
    floating, perched, below = [], [], []  # below: (z, everything, part only) for the layers just under this one
    eight = np.ones((3, 3), bool)
    for n, layer in enumerate(layers, 1):
        if max_z is not None and layer["z"] > max_z:
            break
        img = raster.draw(layer["strokes"])
        mask = img > 0
        part = mask & ~np.isin(img, [i + 1 for i, f in enumerate(raster.labels) if is_support(f)])
        below = [b for b in below if layer["z"] - layer["height"] - LOOKBACK_MM <= b[0] < layer["z"] - 1e-6]
        if n > 1 and mask.any():
            union = lambda k: grow(np.logical_or.reduce([b[k] for b in below]) if below else np.zeros_like(mask))  # noqa: E731
            under, under_part = union(1), union(2)  # dilated: rasterizing can leave a pixel's gap between touching paths
            labels, count = ndimage.label(mask, eight)
            held = set(np.unique(labels[under & mask]).tolist())
            on_part = set(np.unique(labels[under_part & mask]).tolist())
            areas = np.bincount(labels.ravel(), minlength=count + 1) * CHECK_RES**2
            part_areas = np.bincount(labels[part], minlength=count + 1) * CHECK_RES**2
            hits = [(i, sl, floating if i not in held else perched) for i, sl in enumerate(ndimage.find_objects(labels), 1)
                    if (i not in held and areas[i] >= MIN_ISLAND_MM2)
                    or (i not in on_part and layer["z"] > 3 and part_areas[i] >= PERCHED_MIN_MM2 and part_areas[i] > areas[i] / 2)]
            objects = raster.draw(layer["strokes"], key=lambda s: ("object", s[2])) if hits else None
            for i, sl, into in hits:
                here = labels[sl] == i
                into.append({"layer": n, "z": layer["z"], "box": raster.box(sl), "area_mm2": float(areas[i]),
                             "features": raster.names(img[sl], here), "objects": [o[1] for o in raster.names(objects[sl], here)]})
        below.append((layer["z"], mask, part))
    return floating, perched


def thin_trunks(layers: list[dict], raster: Raster, perched: list[dict]) -> list[dict]:
    """Perched islands that grow heavy on thin supports: 15 mm higher, the part grown from the island (not yet joined to
    the rest of the part) covers at least HEAVY_MM2, while halfway down to the bed the supports under it total less than
    THIN_TRUNK_MM2. Adds heavy_mm2, trunk_mm2 and trunk_z."""
    import numpy as np
    from scipy import ndimage
    zs = [layer["z"] for layer in layers]
    at = lambda z: layers[min(range(len(zs)), key=lambda k: abs(zs[k] - z))]  # noqa: E731
    support_ids = lambda: [i + 1 for i, f in enumerate(raster.labels) if is_support(f)]  # noqa: E731

    def window(box, pad):
        x0, y0, x1, y1 = box
        c0, r0 = (max(0, int((v - pad - o) / CHECK_RES)) for v, o in ((x0, raster.x0), (y0, raster.y0)))
        c1, r1 = (int((v + pad - o) / CHECK_RES) for v, o in ((x1, raster.x0), (y1, raster.y0)))
        return slice(r0, r1), slice(c0, c1)

    def part_mask(layer):
        img = raster.draw(layer["strokes"])
        return (img > 0) & ~np.isin(img, support_ids())

    out = []
    for isl in perched:
        mid = at(isl["z"] / 2)
        trunk = float((raster.draw([s for s in mid["strokes"] if is_support(s[0])])[window(isl["box"], 3)] > 0).sum() * CHECK_RES**2)
        if trunk >= THIN_TRUNK_MM2:
            continue
        start, later = part_mask(layers[isl["layer"] - 1]), part_mask(at(isl["z"] + 15))
        seed = np.zeros_like(start)
        seed[window(isl["box"], 0)] = start[window(isl["box"], 0)]
        rooted = ndimage.binary_dilation(start & ~seed, iterations=2)  # the rest of the part at the island's first layer
        labels, _ = ndimage.label(later, np.ones((3, 3), bool))
        grown = set(np.unique(labels[ndimage.binary_dilation(seed, iterations=5) & later]).tolist()) - {0}
        grown -= set(np.unique(labels[rooted & later]).tolist())  # it joined the rest of the part: no longer on its own
        heavy = float(np.isin(labels, list(grown)).sum() * CHECK_RES**2) if grown else 0.0
        if heavy >= HEAVY_MM2:
            out.append({**isl, "heavy_mm2": heavy, "trunk_mm2": trunk, "trunk_z": mid["z"]})
    return out


def group_islands(islands: list[dict]) -> list[dict]:
    """Merge islands that overlap in XY (within 2 mm) and follow each other within 1.5 mm of z into one finding."""
    groups = []
    for isl in islands:
        x0, y0, x1, y1 = isl["box"]
        g = next((g for g in groups if isl["z"] - g["z1"] <= 1.5 and x0 <= g["box"][2] + 2 and g["box"][0] <= x1 + 2
                  and y0 <= g["box"][3] + 2 and g["box"][1] <= y1 + 2), None)
        if g is None:
            groups.append({**isl, "z0": isl["z"], "z1": isl["z"], "layer0": isl["layer"], "layer1": isl["layer"], "count": 1})
            continue
        gx0, gy0, gx1, gy1 = g["box"]
        g.update(z1=isl["z"], layer1=isl["layer"], count=g["count"] + 1, area_mm2=g["area_mm2"] + isl["area_mm2"],
                 box=(min(gx0, x0), min(gy0, y0), max(gx1, x1), max(gy1, y1)),
                 features=sorted({*g["features"], *isl["features"]}), objects=sorted({*g["objects"], *isl["objects"]}, key=str))
    return groups


def footprints(layer: dict, raster: Raster) -> list[dict]:
    """What touches the bed, one entry per patch: a part merged with the support pad around it, or a support pad on its
    own. Each: box, area_mm2 (everything extruded), part_mm2 (the part's own contact), objects, brim (one touches it)."""
    import numpy as np
    from scipy import ndimage
    img = raster.draw(layer["strokes"])
    objects = raster.draw(layer["strokes"], key=lambda s: ("object", s[2]))
    brim = np.isin(img, [i + 1 for i, f in enumerate(raster.labels) if f in ("Brim", "Skirt")])
    support = np.isin(img, [i + 1 for i, f in enumerate(raster.labels) if is_support(f)])
    part = (img > 0) & ~brim & ~support
    labels, _ = ndimage.label(ndimage.binary_closing(part | support, iterations=2), np.ones((3, 3), bool))
    pad = round(1.0 / CHECK_RES)  # a brim within 1 mm counts
    out = []
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        here = labels[sl] == i
        ys, xs = (slice(max(0, s.start - pad), s.stop + pad) for s in sl)
        near = ndimage.binary_dilation(labels[ys, xs] == i, iterations=pad)
        out.append({"box": raster.box(sl), "area_mm2": float((here & (part[sl] | support[sl])).sum() * CHECK_RES**2),
                    "part_mm2": float((here & part[sl]).sum() * CHECK_RES**2), "objects": [o[1] for o in raster.names(objects[sl], here)],
                    "brim": bool((near & brim[ys, xs]).any())})
    return out


def cut_brims(layer: dict, head: str, cfg: dict) -> list[tuple[int | None, tuple, str, float]]:
    """Brims the bed's edge cuts on layer 1: (object, its wall's box, side, mm of brim left there) for each side of a part where its
    brim runs to the edge of the printable area and stops short of the width asked. Studio's arrange sets parts about
    1 mm from the edge without counting their brim (edge rings kept 1.2 mm of 8); `slice` now arranges
    around that, but a plate from elsewhere or a --place by the edge can still have one."""
    width = float(cfg.get("brim_width") or 0)
    if width <= 0 or cfg.get("brim_type") in ("no_brim", "inner_only"):
        return []
    area, shift = re.search(r"^; printable_area = (.+)$", head, re.M), re.search(r"^; extruder_offset = (-?[\d.]+)x(-?[\d.]+)", head, re.M)
    pts = points(area[1].split(",")) if area else [(0, 0), (256, 256)]
    dx, dy = (float(shift[1]), float(shift[2])) if shift else (0.0, 0.0)  # the P1s' 0x2: G-code y runs 2 mm behind the plate's
    bx0, by0 = min(x for x, _ in pts) - dx, min(y for _, y in pts) - dy
    bx1, by1 = max(x for x, _ in pts) - dx, max(y for _, y in pts) - dy
    walls, brims = {}, {}
    for feature, _, obj, line in layer["strokes"]:
        if feature in ("Outer wall", "Brim"):  # a plate of one object may carry no object labels (obj None)
            (walls if feature == "Outer wall" else brims).setdefault(obj, []).extend(line)
    out = []
    for obj, wall in walls.items():
        if not (brim := brims.get(obj)):
            continue
        wx, wy, rx, ry = [p[0] for p in wall], [p[1] for p in wall], [p[0] for p in brim], [p[1] for p in brim]
        for side, left, at_edge in (("left", min(wx) - min(rx), min(rx) - bx0), ("right", max(rx) - max(wx), bx1 - max(rx)),
                                    ("front", min(wy) - min(ry), min(ry) - by0), ("back", max(ry) - max(wy), by1 - max(ry))):
            if at_edge < 0.5 and left < width - 1:
                out.append((obj, (min(wx), min(wy), max(wx), max(wy)), side, max(left, 0.0)))
    return out


def material(filament_type: str) -> str | None:
    """'PETG', 'PLA', ... for a slicer filament type like 'PLA-CF' (None if it isn't one we know)."""
    return next((m for m in FIRST_LAYER_MIN_C if filament_type.upper().startswith(m)), None)


def first_layer_warnings(cfg: dict, head: str) -> list[str]:
    """Nozzle and bed temperature for the material, and the plate the slice was made for (`head`: the G-code's start)."""
    out, kind, plate = [], material(cfg.get("filament_type", "")), cfg.get("curr_bed_type", "?")
    nozzle = int(float(cfg.get("nozzle_temperature_initial_layer", 0)))
    bed_key = PLATE_TEMP_KEYS.get(plate, "") + "_initial_layer"
    bed_cmd = re.search(r"^[ \t]*M190 S(\d+)", head, re.M) or re.search(r"^[ \t]*M140 S(\d+)", head, re.M)
    bed = int(bed_cmd[1]) if bed_cmd else int(float(cfg.get(bed_key, 0)))
    if not kind:
        return [f"unknown filament type {cfg.get('filament_type')!r}; first-layer temperatures not checked"]
    if nozzle < FIRST_LAYER_MIN_C[kind]:
        out.append(f"first layer: nozzle {nozzle} °C is below the usual {FIRST_LAYER_MIN_C[kind]}+ for {kind}; it may not stick or may ball up "
                   f"on the nozzle (reslice with --fset nozzle_temperature_initial_layer=...)")
    lo, hi = BED_RANGE_C[kind]
    if not lo <= bed <= hi:
        out.append(f"first layer: bed {bed} °C, but {kind} usually wants {lo}-{hi} °C (check --plate)")
    if plate != INSTALLED_PLATE:
        out.append(f"first layer: sliced for the {plate}, but both printers have the {INSTALLED_PLATE}; reslice with --plate textured")
    elif cfg.get(bed_key) in ("0", "0.0"):
        out.append(f"first layer: the {cfg.get('filament_type')} preset has no bed temperature for the {plate}")
    return out


def where(box, objects) -> str:
    """'S764-V1-HEAD at x 180-185 y 43-47' (object names when known)."""
    names = ", ".join(str(o) for o in objects if o is not None)
    return (f"{names} at " if names else "") + f"x {box[0]:.0f}-{box[2]:.0f} y {box[1]:.0f}-{box[3]:.0f}"


def listing(items: list[str], limit: int = 4) -> str:
    """'a; b; c; +2 more'."""
    return "; ".join(items[:limit]) + (f"; +{len(items) - limit} more" if len(items) > limit else "")


def check(path: Path, max_z: float | None = None) -> dict:
    """Review a sliced .gcode.3mf (plate 1): {errors, warnings, tree_floating (floating islands on a tree-support slice)}.
    Prints a one-line header with the run time."""
    started = time.monotonic()
    with zipfile.ZipFile(path) as z:
        gcode = z.read("Metadata/plate_1.gcode").decode(errors="ignore")
    cfg, head, layers = gcode_config(gcode), gcode[:400_000], read_layers(gcode)
    del gcode
    names = object_names(path)
    name = lambda objs: [names.get(o, f"object {o}") for o in objs if o is not None]  # noqa: E731
    raster = Raster(layers)
    errors, warnings = [], first_layer_warnings(cfg, head)
    kind = material(cfg.get("filament_type", ""))
    supports = cfg.get("enable_support") == "1" and any(is_support(s[0]) for layer in layers for s in layer["strokes"])
    tree = supports and cfg.get("support_type", "").startswith("tree")

    floating, perched = floating_islands(layers, raster, max_z)
    islands = group_islands(floating)
    for g in islands:
        z = f"z {g['z0']:.2f}" + (f"-{g['z1']:.2f}" if g["z1"] > g["z0"] else "") + f" (layer {g['layer0']}" + (f"-{g['layer1']}" if g["layer1"] > g["layer0"] else "") + ")"
        errors.append(f"floating: {g['count']} island(s), {g['area_mm2']:.1f} mm², start in mid-air at {z}, {where(g['box'], name(g['objects']))}: "
                      f"{', '.join(g['features'])}. Nothing is under them, so they'll droop or curl; add supports or re-orient")
    tips = [g for g in islands if g["z0"] > 1 and all(is_support(f) for f in g["features"])]
    if tips:
        warnings.append(f"tilted part: {len(tips)} support branch(es) begin above z 1 mm with nothing under them (the floating errors above at "
                        + ", ".join(f"z {g['z0']:.2f}" for g in tips[:6]) + "). Under a part tilted or overhanging just above the bed, tree "
                        "supports can start a branch in the air instead of on the plate; it prints as a loose curl. Reslice with normal "
                        "supports (slice does this by itself when it sees them) or re-orient the part")
    if trunks := thin_trunks(layers, raster, perched):
        warnings.append("single thin trunk: " + listing([f"{where(t['box'], name(t['objects']))} starts at z {t['z']:.1f} on supports of "
                                                         f"{t['trunk_mm2']:.0f} mm² (at z {t['trunk_z']:.1f}) and grows to {t['heavy_mm2']:.0f} mm² by z {t['z'] + 15:.0f}" for t in trunks])
                        + ". A heavy island (a ball, a head, an arm end) on one trunk tips over; lay the part down, split it, "
                        "or use normal supports")

    pads = footprints(layers[0], raster) if layers else []
    small = [f for f in pads if f["part_mm2"] and f["area_mm2"] < SMALL_FOOTPRINT_MM2 and not f["brim"]]
    if small:
        warnings.append("no brim: " + listing([f"{where(f['box'], name(f['objects']))} has only {f['area_mm2']:.0f} mm² on the bed" for f in small])
                        + ". Small contacts pop loose; reslice with --brim 5 (the default)")
    if kind == "ASA" and (bare := [f for f in pads if f["part_mm2"] and not f["brim"] and f not in small]):
        warnings.append(f"ASA without a brim: {len(bare)} part(s) ({listing(sorted({n for f in bare for n in name(f['objects'])}))}) have none. "
                        "ASA lifts on an open-frame printer; every ASA part gets a brim of at least 5 mm")
    if layers and (cut := cut_brims(layers[0], head, cfg)):
        warnings.append("brim cut by the bed's edge: " + listing([f"{'' if name([o]) else 'the part at '}{where(box, name([o]))} keeps {left:.1f} of its {float(cfg['brim_width']):g} mm brim "
                                                                   f"on its {side}" for o, box, side, left in cut])
                        + ". A cut brim holds that edge down far less (four of six ASA rings on a plate were cut like this, and "
                        "rings warped); fewer parts on the plate let `slice` keep every brim whole, or move it in with --place")
    raft = cfg.get("raft_layers", "0") not in ("0", "")  # a raft is one wide support pad on purpose
    if not raft and (bare_pads := [f for f in pads if f["part_mm2"] < TREE_PAD_SHARE * f["area_mm2"] and not f["brim"] and f not in small]):
        warnings.append(f"un-brimmed support pads: {len(bare_pads)} patch(es) on the bed are mostly support with no brim ("
                        + listing([f"{where(f['box'], name(f['objects']))}: {f['area_mm2'] - f['part_mm2']:.0f} mm² support, {f['part_mm2']:.0f} mm² part"
                                   for f in bare_pads], 3)
                        + "). Pads lift and trunks fall over. Lay the part on a face of its own, add a raft (--set raft_layers=2), or for "
                        "tree supports keep the brim on (it wraps their bases; it doesn't wrap normal-support pads)")
    if tree and (perched_pads := [f for f in pads if f["part_mm2"] and f["part_mm2"] < TREE_PAD_SHARE * f["area_mm2"] and f["brim"]]):
        warnings.append(f"stands on tree supports: {len(perched_pads)} part(s) touch the bed mostly through tree-support pads ("
                        + listing([f"{', '.join(name(f['objects'])) or where(f['box'], [])} {f['part_mm2']:.0f} of {f['area_mm2']:.0f} mm²" for f in perched_pads], 3)
                        + "). Tree pads are thin and lift; use normal supports so each part starts on one wide pad")

    if supports:
        if cfg.get("support_interface_spacing") not in ("0", "0.0", "0%"):
            warnings.append(f"support roofs: support_interface_spacing is {cfg.get('support_interface_spacing')} (gappy roofs leave a rough face); "
                            "the smooth-roof settings are spacing 0, 3 top layers, support ironing, top gap = one layer (the slice default now)")
        if cfg.get("independent_support_layer_height") == "1":
            warnings.append("supports print on their own layer heights (independent_support_layer_height=1); keep them on the part's layers")
        if cfg.get("support_on_build_plate_only") == "1":
            warnings.append("supports from the bed only: overhangs above other parts of the model get none; check them, or use --supports everywhere")

    checked = f"to z {max_z:g}" if max_z is not None and layers and layers[-1]["z"] > max_z else "all"
    print(f"check {path.name}: {cfg.get('filament_type', '?')}, {len(layers)} layers ({checked} checked) in {time.monotonic() - started:.1f} s")
    return {"errors": errors, "warnings": warnings, "tree_floating": bool(tree and islands),
            "wants_brim": bool(small or (not raft and bare_pads) or (tree and perched_pads))}


def report_check(path: Path, max_z: float | None = None) -> dict:
    """Run `check` and print its findings."""
    result = check(path, max_z)
    for e in result["errors"]:
        print(f"  ERROR {e}")
    for w in result["warnings"]:
        print(f"  WARNING {w}")
    if not result["errors"] and not result["warnings"]:
        print("  ok: no floating islands, brims where needed, first layer suits the material")
    return result


def check_cmd(args):
    if report_check(Path(args.file).expanduser().resolve(), args.max_z)["errors"]:
        sys.exit(1)


# ================================================================== inspect (orientation + overhangs)
DOWN = {  # side of the part that goes on the bed ("y+" = the +y face) -> rotation taking its outward normal to -z
    "z-": ((1, 0, 0), (0, 1, 0), (0, 0, 1)), "z+": ((1, 0, 0), (0, -1, 0), (0, 0, -1)),
    "y+": ((1, 0, 0), (0, 0, 1), (0, -1, 0)), "y-": ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
    "x+": ((0, 0, 1), (0, 1, 0), (-1, 0, 0)), "x-": ((0, 0, -1), (0, 1, 0), (1, 0, 0)),
}
BANDS = [(45, 60, (242, 177, 52), "45-60°"), (60, 75, (239, 125, 34), "60-75°"), (75, 90.01, (217, 40, 28), "75-90° (flat)")]
BED_RGB, PART_RGB = (59, 130, 246), (214, 218, 222)
CUT = 0.013  # section plane y (mm): just off center, since symmetric meshes put whole vertex rings exactly on y = 0


def read_stl(path: Path):
    import numpy as np
    b = path.read_bytes()
    n = struct.unpack("<I", b[80:84])[0]
    if 84 + 50 * n == len(b):
        rec = np.frombuffer(b, dtype=[("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")], count=n, offset=84)
        return rec["v"].reshape(-1, 3, 3).astype(float)
    return np.array(re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", b), dtype=float).reshape(-1, 3, 3)


def oriented(v, down: str):
    """The part turned so `down` faces the bed, centered on x/y and sitting on z = 0."""
    import numpy as np
    v = v @ np.array(DOWN[down], float).T
    lo, hi = v.reshape(-1, 3).min(0), v.reshape(-1, 3).max(0)
    return v - [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]]


def face_stats(v):
    """Per triangle: area, unit normal, whether it rests on the bed, and overhang angle (0 = wall, 90 = flat ceiling)."""
    import numpy as np
    cr = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    size = np.linalg.norm(cr, axis=1)
    n = cr / np.maximum(size, 1e-12)[:, None]
    on_bed = (n[:, 2] < -0.99) & (v[:, :, 2].max(1) < 0.1)
    return size / 2, n, on_bed, np.degrees(np.arcsin(np.clip(-n[:, 2], 0, 1)))


def overhang_areas(v) -> dict:
    area, _, on_bed, ang = face_stats(v)
    return {"bed": area[on_bed].sum(), **{label: area[(ang >= lo) & (ang < hi) & ~on_bed].sum() for lo, hi, _, label in BANDS},
            "height": v[:, :, 2].max()}


def render_sheet(v, out: Path, title: str, stats: dict):
    """Overhang sheet: the part in print orientation from above and from below (where overhangs face), plus a
    half-section with its cut outline in black for hidden internal ceilings. Painter's-algorithm orthographic raster."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    area, n, on_bed, ang = face_stats(v)
    rgb = np.tile(np.array(PART_RGB, float), (len(v), 1))
    for lo, hi, c, _ in BANDS:
        rgb[(ang >= lo) & (ang < hi) & ~on_bed] = c
    rgb[on_bed] = BED_RGB
    views = [("from above, front", -50, 25), ("from above, back", 130, 25), ("half-section (cut outline in black)", -90, 0),
             ("from below, front", -50, -35), ("from below, back", 130, -35)]
    S, SS = 600, 2  # panel px, supersampling
    font = ImageFont.load_default(size=13 * SS)
    sheet = Image.new("RGB", (3 * S, 2 * S), "white")

    def basis(az, el):
        az, el = np.radians(az), np.radians(el)
        cam = np.array([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])  # toward the camera
        right = np.cross(np.array([0, 0, 1.0]), cam)
        right /= np.linalg.norm(right)
        return cam, right, np.cross(cam, right)

    extent = max(np.ptp(v.reshape(-1, 3) @ np.stack(basis(az, el)[1:]).T, axis=0).max() for _, az, el in views)
    k = S * SS * 0.8 / extent  # same mm scale on every panel
    for i, (label, az, el) in enumerate(views):
        cam, right, up = basis(az, el)
        keep = n @ cam > 0
        if label.startswith("half"):
            keep &= v[:, :, 1].mean(1) > CUT  # drop the half nearest the camera (camera sits on -y)
        tri, col = v[keep], rgb[keep] * (0.55 + 0.45 * np.clip(n[keep] @ cam, 0, 1))[:, None]
        order = np.argsort(tri.mean(1) @ cam)  # far first
        p = v.reshape(-1, 3)
        mid = np.array([(p @ right).min() + (p @ right).max(), (p @ up).min() + (p @ up).max()]) / 2
        to_px = lambda q: np.stack([S * SS / 2 + (q @ right - mid[0]) * k, S * SS / 2 - (q @ up - mid[1]) * k], -1)  # noqa: E731
        img = Image.new("RGB", (S * SS, S * SS), "white")
        draw = ImageDraw.Draw(img)
        xy = to_px(tri)
        for t in order:
            draw.polygon([tuple(q) for q in xy[t]], fill=tuple(int(c) for c in col[t]))
        if label.startswith("half"):  # outline where the cut plane meets the walls
            d = v[:, :, 1] - CUT
            segs = []
            for t in np.nonzero((d.min(1) < 0) & (d.max(1) > 0))[0]:
                pts = [v[t, a] + (v[t, b] - v[t, a]) * (d[t, a] / (d[t, a] - d[t, b])) for a, b in ((0, 1), (1, 2), (2, 0)) if d[t, a] * d[t, b] < 0]
                if len(pts) == 2:
                    segs.append(pts)
            for s in to_px(np.array(segs)) if segs else []:
                draw.line([tuple(s[0]), tuple(s[1])], fill="black", width=3 * SS)
        draw.text((14 * SS, 12 * SS), label, fill="black", font=font)
        sheet.paste(img.resize((S, S), Image.LANCZOS), ((i % 3) * S, (i // 3) * S))
    draw = ImageDraw.Draw(sheet)
    x0, y0 = 2 * S + 30, S + 30
    draw.text((x0, y0), title, fill="black", font=ImageFont.load_default(size=18))
    rows = [(BED_RGB, f"on the bed: {stats['bed']:.0f} mm²")] + [(c, f"{lab} overhang: {stats[lab]:.0f} mm²") for _, _, c, lab in BANDS]
    for j, (c, text) in enumerate(rows):
        y = y0 + 44 + j * 30
        draw.rectangle([x0, y, x0 + 20, y + 20], fill=c)
        draw.text((x0 + 32, y + 2), text, fill="black", font=ImageFont.load_default(size=15))
    size = np.ptp(v.reshape(-1, 3), axis=0)
    draw.text((x0, y0 + 44 + len(rows) * 30 + 10), f"{size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} mm (x, y, z)\n"
              "Gray faces need no support. Under 45° prints clean;\n45-60° roughens, worse in TPU; 60°+ needs support.",
              fill="#444", font=ImageFont.load_default(size=13))
    sheet.save(out)


def inspect_cmd(args):
    path = Path(args.stl).expanduser().resolve()
    raw = read_stl(path)
    table = {down: overhang_areas(oriented(raw, down)) for down in DOWN}
    print(f"{path.name}: area per orientation (mm²), side on the bed first")
    for down, s in table.items():
        print(f"  {down} down  bed {s['bed']:6.0f}   " + "  ".join(f"{lab.split()[0]} {s[lab]:6.0f}" for *_, lab in BANDS) + f"   height {s['height']:5.1f}")
    down = args.down or min(table, key=lambda d: (3 * table[d][BANDS[2][3]] + 2 * table[d][BANDS[1][3]] + table[d][BANDS[0][3]], -table[d]["bed"]))
    v = oriented(raw, down)
    out = Path(args.out).expanduser() if args.out else path.with_name(f"{path.stem}-{down}.png")
    render_sheet(v, out, f"{path.name}, {down} side down", table[down])
    print(f"sheet ({down} down): {out}")
    if args.write:
        import numpy as np
        rec = np.zeros(len(v), dtype=[("n", "<3f4"), ("v", "<9f4"), ("a", "<u2")])
        rec["n"], rec["v"] = face_stats(v)[1], v.reshape(-1, 9)
        Path(args.write).expanduser().write_bytes(b"bambu inspect".ljust(80, b" ") + struct.pack("<I", len(v)) + rec.tobytes())
        print(f"wrote {args.write} ({down} down, on z = 0)")


# ================================================================== printer config (one env file per printer)

MODELS = {"C11": "P1P", "C12": "P1S", "N1": "A1 mini", "N2S": "A1", "BL-P001": "X1C", "BL-P002": "X1", "C13": "X1E", "O1D": "H2D", "O1C2": "H2C", "N7": "P2S"}


class PrinterError(Exception):
    """Something that stops a command, shown as one line rather than a traceback."""


def read_env(path: Path) -> dict[str, str]:
    pairs = (line.strip().split("=", 1) for line in path.read_text().splitlines() if "=" in line and not line.strip().startswith("#"))
    return {k.strip(): v.strip() for k, v in pairs}


def configured() -> dict[str, dict[str, str]]:
    """Every printer with an env file, by id (the file's stem)."""
    return {p.name.removesuffix(".env"): read_env(p) for p in sorted(CONFIG.glob("*.env"))}


def ssdp_listen(seconds: float, want: set[str] | None = None) -> dict[str, dict[str, str]]:
    """Bambu printers announce themselves with an SSDP NOTIFY on UDP 2021 (some firmware also 1990) about every 10 s,
    and don't answer M-SEARCH, so this just listens. Returns serial -> host, model, name, connect (lan/cloud), bind,
    firmware. Stops early once every serial in `want` has been heard."""
    socks = []
    for port in (2021, 1990):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)  # Bambu Studio or a parallel lookup may be listening too
        try:
            s.bind(("", port))
            socks.append(s)
        except OSError:
            s.close()
    if not socks:
        raise PrinterError("discover: can't listen on UDP 2021 or 1990 for printer broadcasts")
    found, end = {}, time.monotonic() + seconds
    try:
        while (left := end - time.monotonic()) > 0 and not (want and want.issubset(found)):
            for s in select.select(socks, [], [], min(left, 1.0))[0]:
                data, addr = s.recvfrom(4096)
                h = {k.strip().lower(): v.strip() for k, sep, v in (line.partition(":") for line in data.decode(errors="ignore").splitlines()) if sep}
                if "bambulab" in h.get("nt", "") and h.get("usn"):
                    found[h["usn"]] = {"host": h.get("location") or addr[0], "model": h.get("devmodel.bambu.com", "?"),
                                       "name": h.get("devname.bambu.com", "?"), "connect": h.get("devconnect.bambu.com", "?"),
                                       "bind": h.get("devbind.bambu.com", "?"), "firmware": h.get("devversion.bambu.com", "?")}
    finally:
        for s in socks:
            s.close()
    return found



def ams_trays(s: dict) -> list[dict]:
    """The AMS slots a printer reports (none without an AMS): tray (global tray id, ams*4 + slot, what ams_mapping uses),
    label ('A1' as on the printer's screen), present (filament in the slot), type, color (RRGGBB), remain (% or None
    when the spool doesn't report it), rfid (a Bambu spool whose tag sets type and color), active (fed to the toolhead)."""
    ams = s.get("ams") or {}
    now = str(ams.get("tray_now", "255"))
    exist = int(ams.get("tray_exist_bits") or "0", 16)
    out = []
    for unit in ams.get("ams") or []:
        a = int(unit.get("id", 0))
        for t in unit.get("tray") or []:
            tray = a * 4 + int(t.get("id", 0))
            out.append({"tray": tray, "label": f"{'ABCD'[a] if a < 4 else a}{tray % 4 + 1}", "present": bool(exist >> tray & 1) or bool(t.get("tray_type")),
                        "type": t.get("tray_type") or None, "color": (t.get("tray_color") or "")[:6].upper() or None,
                        "remain": t["remain"] if isinstance(t.get("remain"), int) and t["remain"] >= 0 else None,
                        "rfid": (t.get("tray_uuid") or "0").strip("0") != "" or (t.get("tag_uid") or "0").strip("0") != "",
                        "active": now == str(tray)})
    return out


def tray_arg(text: str) -> int:
    """argparse type for an AMS slot: 'A1'..'D4' as on the printer's screen, or the tray number 0-15 (A1 = 0)."""
    if m := re.fullmatch(r"([A-Da-d])([1-4])", text):
        return "ABCD".index(m[1].upper()) * 4 + int(m[2]) - 1
    if text.isdigit() and int(text) < 16:
        return int(text)
    raise argparse.ArgumentTypeError("an AMS slot is A1-A4 (B1... for a second AMS) or its tray number 0-15 (A1 = 0)")


def ams_arg(text: str):
    """argparse type for print --ams: a slot (tray number), 'auto' or 'ext'."""
    return text.lower() if text.lower() in ("auto", "ext") else tray_arg(text)


def ams_map_arg(text: str) -> list:
    """argparse type for --ams-map '0,2' / 'A1,A3': one slot per filament, in order."""
    return [ams_arg(t.strip()) for t in text.split(",")]


def tray_label(tray: int) -> str:
    return f"{'ABCD'[tray // 4]}{tray % 4 + 1}"


def discover_cmd(args):
    """Listens for printer broadcasts and marks the ones already configured."""
    printers = configured()
    known = {env.get("BAMBU_SERIAL"): (name, env.get("BAMBU_HOST")) for name, env in printers.items()}
    print(f"listening {args.seconds:g} s for Bambu printer broadcasts (UDP 2021/1990)...", file=sys.stderr, flush=True)
    found = ssdp_listen(args.seconds)
    for serial, d in sorted(found.items(), key=lambda kv: kv[1]["host"]):
        name, host = known.get(serial, (None, None))
        if not name:
            mark = f"not configured: an ID.env in {CONFIG} with BAMBU_HOST={d['host']}, BAMBU_SERIAL={serial} and the access code from its screen"
        elif not printers[name].get("BAMBU_ACCESS_CODE"):
            mark = f"configured as {name}, not set up yet: its env file has no BAMBU_ACCESS_CODE"
        elif host != d["host"]:
            mark = f"configured as {name}, but its file says {host} (rewritten once it's been unreachable 10 min)"
        else:
            mark = f"configured as {name}"
        print(f"{d['host']:<15}  {serial}  {MODELS.get(d['model'], d['model'])}  {d['name']}  connect={d['connect']} bind={d['bind']}  fw {d['firmware']}  -- {mark}")
    for serial, (name, host) in known.items():
        if serial and serial not in found:
            print(f"{host or '?':<15}  {serial}  {name}: no broadcast heard (off or asleep? or listen longer with --seconds 30)")


def sliced_filament(path: Path) -> str | None:
    with zipfile.ZipFile(path) as z:
        m = re.search(r"; filament_type = ([^\n]+)", z.read("Metadata/plate_1.gcode").decode(errors="ignore")[:200_000])
    return m[1].strip() if m else None


def sliced_filaments(path: Path) -> list[dict]:
    """The filaments a slice uses: [{id (1-based, as in part.stl@2), type, color (RRGGBB), idx (its preset's filament id,
    like GFG96, the printer's tray_info_idx)}], from slice_info.config, else the G-code header's first filament."""
    with zipfile.ZipFile(path) as z:
        info = z.read("Metadata/slice_info.config").decode(errors="ignore") if "Metadata/slice_info.config" in z.namelist() else ""
    idx = {int(m[1]): m[2] for m in re.finditer(r'<filament id="(\d+)"[^>]*? tray_info_idx="([^"]*)"', info)}
    found = [{"id": int(m[1]), "type": m[2], "color": m[3].lstrip("#")[:6].upper(), "idx": idx.get(int(m[1])) or None}
             for m in re.finditer(r'<filament id="(\d+)"[^>]*? type="([^"]*)" color="([^"]*)"', info)]
    return found or [{"id": 1, "type": sliced_filament(path), "color": None, "idx": None}]


def sliced_nozzle_range(path: Path) -> tuple[int, int] | None:
    """The nozzle temperature range of the slice's (first) filament preset, as its G-code's config block has it."""
    with zipfile.ZipFile(path) as z:
        gcode = z.read("Metadata/plate_1.gcode").decode(errors="ignore")
    got = [re.search(rf"^; nozzle_temperature_range_{end} = (\d+)", gcode, re.M) for end in ("low", "high")]
    return (int(got[0][1]), int(got[1][1])) if all(got) else None


def sliced_model(path: Path) -> str | None:
    """'P1S' for a slice made for the P1S (from the G-code's printer_model)."""
    with zipfile.ZipFile(path) as z:
        m = re.search(r"; printer_model = Bambu Lab (\S+)", z.read("Metadata/plate_1.gcode").decode(errors="ignore")[:400_000])
    return m[1] if m else None


class Unfit(Exception):
    """Why a slice can't run on a printer with what's loaded (one line)."""


def same_type(sliced: str | None, loaded: str | None) -> bool:
    return bool(sliced and loaded and sliced.split(";")[0].upper() == loaded.upper())


def plan_filaments(state: dict, filaments: list[dict], ams=None, ams_map: list | None = None, force: bool = False) -> dict:
    """Where each sliced filament comes from on a printer in `state`: {use_ams, mapping (ams_mapping: per filament
    index the global tray, -1 for unused), trays {filament id: tray}, signature (for the spool-changed purge), known
    (the loaded type is known), notes}. `ams` is None/'auto' (match type, then color, to a loaded AMS slot; the
    external spool if no slot matches), 'ext', or a tray number; `ams_map` gives a tray (or 'ext') per filament in order.
    A printer without an AMS runs single-filament slices from its external spool, as before. Raises Unfit."""
    trays, ext = {t["tray"]: t for t in ams_trays(state)}, state.get("vt_tray", {}).get("tray_type") or None
    ids = [f["id"] for f in filaments]
    explicit = ams_map is not None or ams not in (None, "auto")

    def external() -> dict:
        if len(filaments) > 1:
            raise Unfit(f"the slice uses {len(filaments)} filaments ({', '.join(f['type'] or '?' for f in filaments)}); only an AMS can feed more than one")
        if not force and ext and filaments[0]["type"] and not same_type(filaments[0]["type"], ext):
            raise Unfit(f"sliced for {filaments[0]['type']} but the external spool is {ext}; swap the spool (and set it with set_filament) or pass force")
        return {"use_ams": False, "mapping": "", "trays": {}, "signature": spool_signature(state), "known": bool(ext), "notes": []}

    if ams == "ext" or (ams_map and all(t == "ext" for t in ams_map)):
        return external()
    if not trays:
        if explicit:
            raise Unfit("it has no AMS (sliced filaments run from its external spool; drop slots)")
        return external()
    notes = []
    if ams_map is not None:
        if len(ams_map) < max(ids):
            raise Unfit(f"slots gives {len(ams_map)} slot(s) but the slice uses filament {max(ids)}; give one slot per filament, in order")
        if "ext" in [ams_map[i - 1] for i in ids]:
            raise Unfit("a print runs from the AMS or the external spool, not both; map every filament to an AMS slot")
        chosen = {i: ams_map[i - 1] for i in ids}
    elif isinstance(ams, int):
        if len(ids) > 1:
            raise Unfit(f"the slice uses {len(ids)} filaments; map each to a slot in slots (e.g. A1, A3) or use auto")
        chosen = {ids[0]: ams}
    else:
        chosen = {}
        for f in filaments:
            fits = [t for t in trays.values() if t["present"] and same_type(f["type"], t["type"])]
            exact = [t for t in fits if f["color"] and t["color"] == f["color"]]
            free = [t for t in fits if t["tray"] not in chosen.values()]
            pick = (exact or (free if len(free) == 1 else []) or [None])[0]
            if pick is None:
                if len(filaments) == 1 and same_type(f["type"], ext):
                    return {**external(), "notes": [f"no AMS slot holds {f['type']}; using the external spool ({ext})"]}
                loaded = ", ".join(f"{t['label']} {t['type'] or '?'} #{t['color'] or '?'}" for t in trays.values() if t["present"]) or "nothing"
                why = "several slots hold it and none matches its color" if len(fits) > 1 else "no slot holds it"
                raise Unfit(f"filament {f['id']} is {f['type']} #{f['color'] or '?'}, and {why} (AMS: {loaded}); load it or pick slots")
            chosen[f["id"]] = pick["tray"]
    for f in filaments:
        t = trays.get(chosen[f["id"]])
        if t is None:
            raise Unfit(f"it has no AMS slot {tray_label(chosen[f['id']])}")
        if not t["present"] or not t["type"]:
            raise Unfit(f"AMS {t['label']} is " + ("empty" if not t["present"] else "loaded but its filament isn't set (set_filament on that slot)"))
        if not same_type(f["type"], t["type"]):
            if not force:
                raise Unfit(f"filament {f['id']} is sliced for {f['type']} but AMS {t['label']} holds {t['type']}; load the right spool, set the slot "
                            f"(set_filament on {t['label']}), map another slot, or pass force")
            notes.append(f"force: filament {f['id']} ({f['type']}) runs from {t['label']}, which holds {t['type']}")
        if f["color"] and t["color"] and f["color"] != t["color"]:
            notes.append(f"filament {f['id']} was sliced as #{f['color']}; {t['label']} holds #{t['color']}")
    mapping = [chosen.get(i, -1) for i in range(1, max(ids) + 1)]
    signature = {"ams": [[chosen[i], trays[chosen[i]]["type"], trays[chosen[i]]["color"]] for i in ids]}
    return {"use_ams": True, "mapping": mapping, "trays": chosen, "signature": signature, "known": True, "notes": notes}


def loaded_setting(state: dict, filaments: list[dict], ams=None, nozzle: tuple[int, int] | None = None) -> dict | None:
    """`print` loaded: the slice's one filament has just been put on the printer, on its external spool or AMS slot `ams`,
    so the printer is told so before anything checks against it, from the slice itself (its type, color and preset id, and
    the preset's nozzle range): {ams_id, tray_id, where, fields (ams_filament_setting's), tray (the AMS tray, None for the
    external spool)}. None when there's nothing to set: a Bambu RFID spool that already reads as the slice's. Raises Unfit
    for a slice of several filaments, an AMS printer with no slot named, a slice that doesn't say its filament, or an RFID
    spool of another filament (the printer sets those from the tag)."""
    if len(filaments) != 1:
        raise Unfit(f"loaded is for one-filament slices, and this one uses {len(filaments)} ({', '.join(f['type'] or '?' for f in filaments)}); "
                    "set each slot with set_filament")
    f = filaments[0]
    if not f["type"] or not f.get("idx") or not nozzle:
        raise Unfit("loaded needs the slice's filament type, preset id and nozzle range from its metadata, and this slice lacks "
                    + ", ".join(w for w, have in (("its type", f["type"]), ("its preset id", f.get("idx")), ("its nozzle range", nozzle)) if not have))
    color = (f["color"] or "FFFFFF")[:6].upper()
    fields = {"tray_info_idx": f["idx"], "tray_type": f["type"], "tray_color": f"{color}FF",
              "nozzle_temp_min": nozzle[0], "nozzle_temp_max": nozzle[1]}
    trays = {t["tray"]: t for t in ams_trays(state)}
    if ams in (None, "auto"):
        if trays:
            raise Unfit("loaded on a printer with an AMS needs where the spool went: slots A1-A4, or ext for the external spool")
        ams = "ext"
    if ams == "ext":
        return {"ams_id": 255, "tray_id": 254, "where": "external spool", "fields": fields, "tray": None}
    t = trays.get(ams)
    if t is None:
        raise Unfit(f"it has no AMS slot {tray_label(ams)}")
    if t["rfid"]:
        if same_type(f["type"], t["type"]) and t["color"] == color:
            return None
        raise Unfit(f"AMS {t['label']} holds a Bambu RFID spool of {t['type'] or '?'} #{t['color'] or '?'}, which the printer sets from its "
                    f"tag, not the slice's {f['type']} #{color}; load the slice's filament there or name another slot")
    return {"ams_id": ams // 4, "tray_id": ams % 4, "where": f"AMS {t['label']}", "fields": fields, "tray": ams}


def apply_loaded(state: dict, setting: dict) -> dict:
    """`state` as the printer reports it once `setting` (loaded_setting's) has taken: what a dry run checks against."""
    keys = {k: setting["fields"][k] for k in ("tray_type", "tray_color", "tray_info_idx")}
    if setting["tray"] is None:
        state["vt_tray"] = {**state.get("vt_tray", {}), **keys}
    for unit in (state.get("ams") or {}).get("ams") or []:
        for t in unit.get("tray") or []:
            if setting["tray"] is not None and int(unit.get("id", 0)) * 4 + int(t.get("id", 0)) == setting["tray"]:
                t.update(keys)
    return state


def describe_plan(plan: dict) -> str:
    """'filament 1 -> AMS A1' / 'external spool'."""
    if not plan["use_ams"]:
        return "external spool"
    return ", ".join(f"filament {i} -> AMS {tray_label(t)}" for i, t in plan["trays"].items())


def project_file_payload(name: str, md5: str, plan: dict, timelapse: bool = False, level: bool = True, vibration: bool = False) -> dict:
    """The MQTT `project_file` command that starts plate 1 of /name on the card. With the AMS: use_ams and ams_mapping
    (per sliced filament, the global tray it runs from; -1 unused), plus ams_mapping2 as Bambu Studio sends it."""
    return {"print": {"sequence_id": "0", "command": "project_file", "param": "Metadata/plate_1.gcode", "url": f"ftp:///{name}", "md5": md5,
                      "subtask_name": name.removesuffix(".gcode.3mf"), "project_id": "0", "profile_id": "0", "task_id": "0", "subtask_id": "0",
                      "timelapse": timelapse, "bed_type": "auto", "bed_leveling": level, "bed_levelling": level, "flow_cali": False,
                      "vibration_cali": vibration, "layer_inspect": False, "use_ams": plan["use_ams"], "ams_mapping": plan["mapping"],
                      **({"ams_mapping2": [{"ams_id": t // 4, "slot_id": t % 4} if t >= 0 else {"ams_id": 255, "slot_id": 255} for t in plan["mapping"]]}
                         if plan["use_ams"] else {})}}


def unfit(s: dict, filaments: list[dict], req: dict) -> str | None:
    """Why printer `auto` can't use a printer in state `s`, or None if it can."""
    state = s.get("gcode_state")
    if state not in ("IDLE", "FINISH"):
        return f"{state or 'no state reported'}"
    try:
        plan_filaments(s, filaments, req["ams"], req["ams_map"], req["force"])
    except Unfit as e:
        return f"{state}, but {e}"
    return None


def stock_unfit(here: str | None, sliced: str | None) -> str | None:
    """Why a stock-only printer (STOCK_MODELS) can't take a plate sliced for another model, or None: plan refuses it,
    so auto must not pick it."""
    if here in STOCK_MODELS and sliced != here:
        return f"a {here}, which runs only plates sliced for the {here} (this one is for the {sliced or 'unknown printer'})"
    return None


def pick_printer(path: Path, printers: dict, req: dict) -> tuple[str, str]:
    """Printer `auto`: an IDLE printer, else a FINISH one (its last print may still be on the bed), that has the
    slice's filaments loaded (external spool, or AMS slots by type and color); a known match beats an unknown spool,
    then a printer of the model the slice was made for, then the order they're given in. `printers` is id -> {state
    (its report, or a string saying why there's none), model}. Returns the id and a line saying why."""
    filaments, names, model = sliced_filaments(path), list(printers), sliced_model(path)
    results = {n: printers[n]["state"] for n in names}
    reasons = {n: r if isinstance(r, str) else stock_unfit(printers[n].get("model"), model) or unfit(r, filaments, req)
               for n, r in results.items()}
    ok = [n for n, why in reasons.items() if why is None]
    sliced = "+".join(f["type"] or "?" for f in filaments)
    if not ok:
        raise PrinterError(f"auto: no printer is free for this {sliced} job:\n" + "\n".join(f"  {n}: {why}" for n, why in reasons.items()))
    plans = {n: plan_filaments(results[n], filaments, req["ams"], req["ams_map"], req["force"]) for n in ok}
    best = min(ok, key=lambda n: (results[n].get("gcode_state") != "IDLE", not plans[n]["known"], printers[n].get("model") != model, names.index(n)))
    state = results[best].get("gcode_state")
    return best, f"auto: picked {best} ({state}, {describe_plan(plans[best])})" + ("; FINISH means the last print may still be on its plate" if state == "FINISH" else "")


# SHORT_PRIME as it comes out of the slicer, which may slip M73 progress lines in between.
TRIMMED_PRIME = re.compile(r"M109 S(\d+) ; trimmed: 10 mm prime instead of the 100 mm flush\n(?:M73 [^\n]*\n|M106 P1 S0\n|G92 E0\n|G1 E10 F200\n|M400\n)+M106 P1 S255\n")


def spool_signature(state: dict) -> dict:
    """What's on the external spool, as far as the printer knows (set by set_filament)."""
    tray = state.get("vt_tray", {})
    return {k: tray.get(k) for k in ("tray_type", "tray_color", "tray_info_idx")}


def spool_changed(last: dict | None, signature: dict) -> bool:
    """True when the filament a print runs from (`signature`: the external spool's spool_signature, or the AMS trays
    with their type and color) differs from this printer's last print (`last`, its signature), or that isn't known.
    Another AMS slot counts as a change."""
    return last is None or last != signature


def with_full_purge(path: Path) -> Path | None:
    """A copy of the slice whose start runs Bambu's full 100 mm flush instead of our trimmed 10 mm prime, under the same
    file name (so the job keeps its name) in the work folder's purge/. None when the slice has the full start."""
    with zipfile.ZipFile(path) as z:
        gcode = z.read("Metadata/plate_1.gcode").decode()
        if not (m := TRIMMED_PRIME.search(gcode)):
            return None
        purged = (gcode[: m.start()] + FLUSH.replace("[nozzle_temperature_initial_layer]", m[1]) + gcode[m.end():]).encode()
        out = CACHE / "purge" / path.name
        out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dest:
            for item in z.infolist():
                data = {"Metadata/plate_1.gcode": purged,
                        "Metadata/plate_1.gcode.md5": hashlib.md5(purged).hexdigest().upper().encode()}.get(item.filename) or z.read(item)
                dest.writestr(item, data)
    return out


def plan_cmd(args):
    """A print, planned as the extension's `print` sends it, from a JSON request on stdin: {file, printer (an id or
    "auto"), printers (id -> {state: its merged report, or why there's none; model: P1P/P1S}), slots (A1..A4 or ext,
    per filament), force, loaded, quick_start, dry_run, level, vibration, check (run the pre-print check first), last
    (the picked printer's last print's spool signature, by id)}. Answers one JSON line: {printer, check (its lines),
    errors, setting (loaded's ams_filament_setting fields, null when nothing to set), plan, notes (the auto pick's
    line first), purge, signature, send (the file to upload: the plate, or its full-purge copy), payload
    (project_file)}, or {error}.
    A dry run, or a request with a setting still to send, makes no purge copy."""
    req = json.loads(sys.stdin.read())
    path = Path(req["file"]).expanduser().resolve()
    slots = [str(x).strip() for x in req.get("slots") or []]
    req["ams"] = ams_arg(slots[0]) if len(slots) == 1 else None
    req["ams_map"] = [ams_arg(x) for x in slots] if len(slots) > 1 else None
    req["force"] = bool(req.get("force"))
    checked, notes = io.StringIO(), []
    errors = 0
    if req.get("check"):
        with contextlib.redirect_stdout(checked):
            errors = len(report_check(path)["errors"])
        if errors and not req["force"]:
            raise PrinterError("not sending: check found errors (fix the slice, or pass force if you've looked and it's fine):\n"
                               + checked.getvalue().rstrip())
        if errors:
            notes.append("force: sending despite the check errors")
    name, printers = req["printer"], req["printers"]
    if name == "auto" and req.get("loaded"):
        raise PrinterError("loaded needs the printer the spool went on, not auto")
    if name == "auto":
        name, why = pick_printer(path, printers, req)
        notes.insert(0, why)
    if name not in printers:
        raise PrinterError(f"no printer {name}")
    state, here = printers[name]["state"], printers[name].get("model")
    if here in STOCK_MODELS and sliced_model(path) != here:
        raise PrinterError(f"not sending to {name}: it's a {here}, which runs only plates sliced with Bambu's own {here} presets, "
                           f"and this one was sliced for the {sliced_model(path) or 'unknown printer'}; re-slice with machine {here.lower()}")
    if isinstance(state, str):
        raise PrinterError(f"{name}: {state}")
    if state.get("gcode_state") in ("RUNNING", "PREPARE", "PAUSE"):
        raise PrinterError(f"{name} is busy ({state.get('gcode_state')}); not sending")
    filaments, model = sliced_filaments(path), sliced_model(path)
    setting = None
    if req.get("loaded"):
        # The setting says what's on the printer, so it changes when the spool goes on, never ahead: loaded is the word
        # that it just did. Set from the slice itself, confirmed before anything checks against it.
        if req["ams_map"]:
            raise PrinterError(f"not sending to {name}: loaded is for one-filament slices; set each slot with set_filament")
        try:
            setting = loaded_setting(state, filaments, req["ams"], sliced_nozzle_range(path))
        except Unfit as e:
            raise PrinterError(f"not sending to {name}: {e}") from e
        if setting:
            apply_loaded(state, setting)
            if req.get("dry_run"):
                what = f"{setting['fields']['tray_type']} #{setting['fields']['tray_color'][:6]}"
                notes.append(f"loaded: a real run first sets {name}'s {setting['where']} to {what}; a dry run sets nothing")
    try:
        plan = plan_filaments(state, filaments, req["ams"], req["ams_map"], req["force"])
    except Unfit as e:
        raise PrinterError(f"not sending to {name}: {e}") from e
    notes += plan["notes"]
    if model and here and model != here:
        notes.append(f"sliced for the {model} but {name} is a {here}; it runs (same G-code family), but re-slice with "
                     f"machine {here.lower()} for its own fan and start settings")
    purge = here not in STOCK_MODELS and not req.get("quick_start") and spool_changed((req.get("last") or {}).get(name), plan["signature"])
    send = path
    if purge and not req.get("dry_run") and not setting and (purged := with_full_purge(path)):
        send = purged
    payload = project_file_payload(path.name, hashlib.md5(send.read_bytes()).hexdigest(), plan, False, req.get("level", True),
                                  bool(req.get("vibration")) and here not in STOCK_MODELS)  # no calibration asked of a stock-only printer
    print(json.dumps({"printer": name, "check": checked.getvalue().splitlines(), "errors": errors, "setting": setting, "plan": describe_plan(plan),
                      "notes": notes, "purge": purge, "signature": plan["signature"], "send": str(send), "payload": payload}))


def listen_cmd(args):
    """Listens for the printers with these serials; one JSON line, serial -> the host each broadcast from."""
    print(json.dumps({serial: d["host"] for serial, d in ssdp_listen(args.seconds, set(args.serial)).items() if serial in args.serial}))


# ================================================================== timelapses
# The extension snaps a print's frames into <root>/<stem>.frames/; `encode` makes <root>/<stem>.mp4 and <stem>.jpg of
# them and deletes the frames.


def note(msg: str):
    """A timestamped line."""
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def frames_of(folder: Path) -> list[Path]:
    """A recording's frames, oldest first (frames being written are still .tmp files). On an exFAT drive macOS keeps
    each file's extended attributes in an AppleDouble twin beside it (._00001.jpg), which isn't a frame."""
    return sorted(f for f in folder.glob("*.jpg") if not f.name.startswith("."))


def remove_frames(folder: Path):
    """Deletes a recording's folder of frames. On exFAT, deleting a file also deletes its AppleDouble twin (._NAME),
    which a listing taken before still names, so a file already gone is fine: shutil.rmtree crashed on exactly that
    (FileNotFoundError on an exFAT drive), before the video was saved."""
    for entry in sorted(folder.iterdir(), key=lambda f: f.name.startswith("._")):  # the twins last: most go with their file
        if entry.is_dir() and not entry.is_symlink():
            remove_frames(entry)
        else:
            entry.unlink(missing_ok=True)
    folder.rmdir()


def thumbnail(src: Path, dest: Path) -> bool:
    """A small (640 px) JPEG of `src`, for previews and messages: Pillow, else ffmpeg. Says whether it wrote one; a
    missing poster never stops a video."""
    try:
        from PIL import Image
        with Image.open(src) as im:
            im.thumbnail((640, 640))
            im.convert("RGB").save(dest, quality=80)
        return True
    except Exception as e:
        why = f"{type(e).__name__}: {e}"
    run = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", "scale='min(640,iw)':-2", "-q:v", "4",
                          "-frames:v", "1", str(dest)], capture_output=True, text=True)
    if run.returncode == 0 and dest.exists():
        return True
    note(f"no poster for {dest.stem} (Pillow: {why}; ffmpeg exit {run.returncode}: {run.stderr.strip()[-300:]})")
    return False


def encode(folder: Path, out: Path) -> bool:
    """folder/*.jpg -> `out`: H.264 (libx264, yuv420p) at 30 fps, at most 1280 px wide, crf 26, the last frame held 2 s,
    in TV range (the camera's JPEGs are full range, which phones and QuickTime play washed out unless converted);
    niced on 4 threads so it leaves the Mac usable. The camera's sensor noise changes every pixel of every frame, so a
    temporal denoise (hqdn3d) goes first: ~25% smaller and cleaner (a print with the light on: ~15 kB per frame).
    Also writes `out` as a small .jpg of the final frame. The frames are deleted once the video is written and kept if
    ffmpeg fails."""
    shots = frames_of(folder)
    if not shots:
        try:
            remove_frames(folder)
        except OSError:
            pass
        note(f"no frames in {folder.name}; nothing to encode")
        return False
    part = out.with_name(f"{out.stem}.part.mp4")
    run = subprocess.run(["nice", "-n", "10", "ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-pattern_type", "glob", "-i", "*.jpg",
                          "-vf", "hqdn3d=6:5:20:20,scale='min(1280,iw)':-2:out_range=tv,format=yuv420p,tpad=stop_mode=clone:stop_duration=2", "-c:v", "libx264", "-crf", "26",
                          "-pix_fmt", "yuv420p", "-threads", "4", "-movflags", "+faststart", str(part)], cwd=folder, capture_output=True, text=True)
    if run.returncode or not part.exists():
        part.unlink(missing_ok=True)
        note(f"ffmpeg failed (exit {run.returncode}); frames kept in {folder}: {run.stderr.strip()[-800:]}")
        return False
    os.replace(part, out)
    poster = thumbnail(shots[-1], out.with_suffix(".jpg"))
    note(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(shots)} frames, {len(shots) / 30 + 2:.0f} s)"
         + (f" and {out.with_suffix('.jpg').name}" if poster else ""))
    try:  # the video is written: tidying up after it must never fail it
        remove_frames(folder)
    except OSError as e:
        note(f"couldn't delete {folder} ({type(e).__name__}: {e}); delete it by hand")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("slice", help="slice STLs onto one plate -> .gcode.3mf (+ .png top view)")
    s.add_argument("out")
    s.add_argument("parts", nargs="+", help="STL paths; 'part.stl:3' for copies, 'part.stl@2' on filament 2, 'base.stl+logo.stl@2' for one "
                   "object of two parts (kept in place) with the logo on filament 2. Orient them for printing first.")
    s.add_argument("--filament", action="append", help=f"{', '.join(FILAMENTS)} or an exact preset name (default pla); repeat for "
                   "filament 2, 3... in order (the last one repeats)")
    s.add_argument("--color", action="append", type=hex_color, help="filament color as hex (FFFFFF), repeat in filament order; "
                   "print matches it to an AMS tray, and multi-filament purges are sized from it")
    s.add_argument("--machine", choices=MACHINES, help="printer model to slice for (default p1p, or p1s when the plate uses more than one filament); "
                   "p2s and h2c slice with Bambu's stock presets and G-code only")
    s.add_argument("--nozzle", choices=NOZZLES, help="the hotend's nozzle in mm (default 0.4): Bambu's machine and process presets for it")
    s.add_argument("--support-filament", type=int, metavar="N", help="filament number for the support bodies")
    s.add_argument("--support-interface-filament", type=int, metavar="N", help="filament number for support interfaces only "
                   "(e.g. PETG under PLA for a clean release; no z gap when the materials differ)")
    s.add_argument("--purge", type=float, metavar="MM3", help="purge volume for every filament change (default: from the colors)")
    s.add_argument("--no-prime-tower", action="store_true", help="multi-filament plates get a prime tower unless this is given")
    s.add_argument("--process", help="process preset (default 0.20mm Standard for the machine)")
    s.add_argument("--plate", choices=PLATES, default="textured")
    s.add_argument("--brim", type=float, help=f"brim width in mm, 0 for none (default 5, or 8 when a part is over {BIG_FOOTPRINT_MM} mm across; ASA at least 5; TPU: none)")
    s.add_argument("--brim-type", choices=BRIM_TYPES, help="outer (default), inner (inside holes only), both (outside and inside holes: rings, frames), "
                   "ears (at sharp corners) or auto (Bambu decides per part)")
    s.add_argument("--brim-gap", type=float, metavar="MM", help="gap on the bed between the brim and the part, as printed (Bambu's default prints "
                   "about 0.23 mm). 0 fuses the brim to the part, for parts that lift; a gap under 0.15 turns the first layer's elephant-foot "
                   "compensation down to it, so the base may flare up to 0.15 mm")
    s.add_argument("--place", action="append", metavar="SPOT", help="put the objects at these spots instead of arranging them, one --place per "
                   "object in order (copies count): X,Y in mm (the footprint's center; 0,0 is the front-left corner, +y the back, as Bambu Studio "
                   f"shows it) or {', '.join(SPOTS)}, which keep the brim {EDGE_MM} mm inside the edge")
    s.add_argument("--walls", type=int)
    s.add_argument("--infill", type=int, help="sparse infill %%")
    s.add_argument("--layer", type=float)
    s.add_argument("--cosmetic", action="store_true", help="round, organic or display parts: 0.16 layers (--layer still wins), the seam on the "
                   "back (+Y, so orient the plain side there), outer wall fixed at 60 mm/s and inner at 150 (about +45%% print time)")
    s.add_argument("--supports", nargs="?", const="bed", choices=["bed", "everywhere"], help="supports from the bed only (default) or everywhere: tree for PLA/TPU, normal grid for PETG/ASA/ABS; "
                   "on the part's layers with smooth roofs. A tree slice with mid-air branches is redone on normal supports")
    s.add_argument("--orient", action="store_true", help="let the slicer auto-orient (off: parts print as exported)")
    s.add_argument("--full-start", action="store_true", help="keep Bambu's full start routine (purge + vibration check)")
    s.add_argument("--soak", type=int, default=0, metavar="MIN", help="heat soak: hold the bed at its first-layer temperature MIN "
                   "minutes after it heats, before leveling and the first layer (ASA/ABS warp); the plate's times count it")
    s.add_argument("--set", action="append", metavar="KEY=VALUE", help="raw process override, repeatable")
    s.add_argument("--fset", action="append", metavar="KEY=VALUE", help="raw filament override (e.g. fan_max_speed=30), repeatable")
    so = sub.add_parser("soak", help="give a sliced .gcode.3mf a heat soak: the bed holds its temperature MIN minutes after it heats, "
                        "before leveling and the first layer (replaces any soak it has; 0 takes it out)")
    so.add_argument("file")
    so.add_argument("minutes", type=int, metavar="MIN")
    so.add_argument("--out", help="write the soaked plate here instead of over the file")
    i = sub.add_parser("info", help="summarise a sliced .gcode.3mf")
    i.add_argument("file")
    ck = sub.add_parser("check", help="review a sliced .gcode.3mf before printing: floating islands, brims, first-layer temps (print runs it too)")
    ck.add_argument("file")
    ck.add_argument("--max-z", type=float, help="only check islands up to this height (mm); default the whole print")
    ins = sub.add_parser("inspect", help="compare bed orientations of an STL and render an overhang sheet (+ rotated STL)")
    ins.add_argument("stl")
    ins.add_argument("--down", choices=DOWN, help="side on the bed for the sheet (default: the one with the least steep overhang)")
    ins.add_argument("--out", help="sheet PNG (default: <stl>-<down>.png next to the STL)")
    ins.add_argument("--write", metavar="STL", help="also write the part turned to that orientation, sitting on z = 0, ready to slice")
    enc = sub.add_parser("encode", help="a timelapse's frames folder -> FOLDER.mp4 (+ .jpg of its last frame); deletes the frames once written")
    enc.add_argument("frames", help="the <stem>.frames folder")
    enc.add_argument("--out", help="the video (default: the folder's name with .mp4)")
    sub.add_parser("plan", help="plan a print from a JSON request on stdin (see plan_cmd)")
    d = sub.add_parser("discover", help="listen for Bambu printers on the LAN and mark the configured ones")
    d.add_argument("--seconds", type=float, default=12, help="how long to listen; each printer broadcasts about every 10 s")
    li = sub.add_parser("listen", help="listen for printers by serial; JSON serial -> host")
    li.add_argument("--serial", action="append", required=True)
    li.add_argument("--seconds", type=float, default=12)
    args = ap.parse_args()
    commands = {"slice": slice_cmd, "inspect": inspect_cmd, "discover": discover_cmd, "check": check_cmd, "soak": soak_cmd,
                "plan": plan_cmd, "listen": listen_cmd, "encode": encode_cmd, "info": lambda a: info(Path(a.file).expanduser().resolve())}
    commands[args.cmd](args)


def encode_cmd(args):
    folder = Path(args.frames).expanduser().resolve()
    if not encode(folder, Path(args.out).expanduser().resolve() if args.out else folder.with_suffix(".mp4")):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except (PrinterError, Unfit) as e:
        if sys.argv[1:2] == ["plan"]:
            print(json.dumps({"error": str(e)}))
        sys.exit(str(e))
