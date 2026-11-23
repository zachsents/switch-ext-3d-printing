# switch-ext-3d-printing

Bambu Lab printers on the LAN, and the only thing that talks to them: one MQTT session and one camera stream per printer. Live state, AMS filament, job control, the whole print (slice, plate, check, plan, purge, upload, start, wait), timelapses, the chamber light kept on through a job, job history and events for every job's start, pause, loss, end and timelapse, with printing and design rules (src/rules.md). Widgets: one per printer, its state, filament and live camera in one cell. Slicing, the check and print planning run in its own library, `lib/bambu.py`, which never connects to a printer.

A [Switch](https://switch.ax) extension, built on
[switch-ext-kit](https://github.com/zachsents/switch-ext-kit).

## Install

Ask Switch's agent to install `github:zachsents/switch-ext-3d-printing`, or add it in the desktop's
Extensions view (⌘K, Extensions). Switch runs it on the first machine with what it needs.

## Setup

On the machine that runs it:

- [uv](https://docs.astral.sh/uv/) and Bambu Studio in `/Applications` (or `$BAMBU_STUDIO`): the library
  slices with Studio's CLI and presets. ffmpeg for timelapse videos.
- One `<id>.env` per printer in `~/.config/bambu` (or `$PRINTERS_CONFIG`), chmod 600:
  `BAMBU_HOST`, `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE` (from the printer's screen) and `NAME` for
  what to call it (rename sets it). Adding a printer is writing its file and restarting the
  extension; `discover` lists the printers on the LAN with their host and serial. A printer that
  moves (DHCP) and stays unreachable 10 minutes is found again by its serial and its file's host
  rewritten.
- `PRINTERS_TIMELAPSES`: colon-separated folders for timelapses. The first on a mounted, writable
  volume wins; the last is the fallback. Unset, they go in the extension's folder.
- If another job tracker reports a printer's outcomes, set `JOB_OUTCOMES=off` in that
  printer's file to omit duplicate completion/failure events. Status, progress, errors,
  cameras and Live Activities continue.
- The extension keeps, in its folder: each printer's last job (`jobs.json`), so a restart
  mid-print keeps its start, its duration and its plate's "Done" time and a job that ended while
  it was down is still reported; every job's history (`jobs.jsonl`, the `jobs` tool); recordings
  in progress (`timelapses.json`, carried on after a restart into the same frames); each printer's
  last spool (`last-spool.json`, for the purge after a spool change); and slicing scratch (`work/`).
- Running uses one activity slot per printer. On reconnect, a running printer replaces
  that slot, and a job kept as running that the printer isn't printing now is ended (finished or failed as
  the printer says, else stopped); an idle printer's ended print isn't ended again.
- Commands reach real printers only with `PRINTERS_COMMANDS=on`; `PRINTERS_SIM=on` runs two
  simulated printers instead.
- The machine running it must provide `lan:printers` (`provides` in `~/.switch/config.json`).
- Env for the extension (`PRINTERS_COMMANDS`, `PRINTERS_TIMELAPSES`) goes in `~/.switch/config.json`
  under `extensionOptions.printers.env`.

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```

## iPhone

`ios/` is Printing for iPhone (SwiftUI, XcodeGen). It reaches this extension through Switch's core,
calling the same tools an agent does. `sh ios/build.sh` installs it on a paired iPhone;
`--simulator` builds it for the simulator. Team, bundle id prefix and the core's address come from
the environment or a `deploy.local` (`ios_team`, `ios_bundle_prefix`, `ios_core`), never the source.
