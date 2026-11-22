# switch-ext-3d-printing

Bambu Lab printers on the LAN: live state over MQTT, cameras, AMS filament, job control, and the whole print: slice, plate, check, send, wait, timelapse, with printing and design rules (src/rules.md). Widgets: one per printer, its state, filament and live camera in one cell.

A [Switch](https://switch.ax) extension, built on
[switch-ext-kit](https://github.com/zachsents/switch-ext-kit).

## Install

Ask Switch's agent to install `github:zachsents/switch-ext-3d-printing`, or add it in the desktop's
Extensions view (⌘K, Extensions). Switch runs it on the first machine with what it needs.

## Setup

- One `<id>.env` per printer in `~/.config/bambu` (or `$PRINTERS_CONFIG`): `BAMBU_HOST`,
  `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE`, and `NAME` for what to call it (rename sets it).
- If another job tracker reports a printer's outcomes, set `JOB_OUTCOMES=off` in that
  printer's file to omit duplicate completion/failure events. Status, progress, errors,
  cameras and Live Activities continue.
- Each printer's last job is kept in the extension's folder (`jobs.json`), so a restart
  mid-print keeps its start, its duration and its plate's "Done" time, and a job that ended
  while it was down is still reported. A job already running when it first connects has no
  duration.
- Running uses one activity slot per printer. On reconnect, a running printer replaces
  that slot, and a job kept as running that the printer isn't printing now is ended (finished or failed as
  the printer says, else done); an idle printer's ended print isn't ended again.
- The `bambu` CLI on `PATH` (or `$PRINTERS_BAMBU`) for slicing and sending.
- Commands reach real printers only with `PRINTERS_COMMANDS=on`; `PRINTERS_SIM=on` runs two
  simulated printers instead.
- The machine running it must provide `lan:printers` (`provides` in `~/.switch/config.json`).

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
