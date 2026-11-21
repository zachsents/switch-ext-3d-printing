// The printers extension as a stdio MCP server. Printers come from ~/.config/bambu (or
// $PRINTERS_CONFIG); PRINTERS_SIM=on runs simulated ones instead. A print shows on the iPhone as a
// Live Activity through the core ($SWITCH_URL, else this machine's).
import { serveStdio } from "switch-ext-kit"

import { Printers, printersApp } from "./app.ts"
import { coreActivities } from "./live.ts"

await serveStdio(
  printersApp,
  Printers.layer({ activities: coreActivities(process.env.SWITCH_URL ?? "http://127.0.0.1:4871") }),
)
