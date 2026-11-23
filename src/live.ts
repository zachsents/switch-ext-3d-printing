// A print in progress as an iPhone Live Activity. iOS draws it from a compiled template, so it's
// not a widget: the iPhone's tools in the core (iphone_live_activity_start, _update, _end) start,
// move and end it, with the progress template. Reached the way an agent reaches them: the core's
// apps over MCP (`/apps`). A missing iPhone or an unreachable core is skipped quietly. It shows in
// the space of the work that sent the print, else the space holding the printer's widget, else Home.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Schema } from "effect"

/** One print's activity: everything the template shows. */
export interface PrintActivity {
  readonly printer: string
  readonly name: string
  readonly file: string
  readonly phase: string
  readonly percent: number
  readonly layer: number
  readonly layers: number
  /** When it'll be done, in ms. */
  readonly endsAt: number | null
}

/** The iPhone's Live Activity tool, by one stable key per printer. */
export interface LiveActivities {
  /** `space`: the space of the work that sent the print, if one did. */
  readonly start: (key: string, content: PrintActivity, space?: string) => Promise<void>
  readonly update: (key: string, content: PrintActivity) => Promise<void>
  readonly end: (key: string, content: PrintActivity) => Promise<void>
}

/** Nothing is called: for running without a core. */
export const noActivities: LiveActivities = {
  start: async () => {
    await Promise.resolve()
  },
  update: async () => {
    await Promise.resolve()
  },
  end: async () => {
    await Promise.resolve()
  },
}

const decodeWidgets = Schema.decodeUnknownOption(
  Schema.Struct({
    widgets: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        name: Schema.String,
        space: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
)

const idOf = (key: string) => `print-${key.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`

/** What the plate's called, without its extensions. */
const plate = (file: string) => file.replace(/\.gcode\.3mf$|\.3mf$|\.gcode$/u, "")

const stateOf = (phase: string) => {
  if (phase === "paused") {
    return "needs"
  }
  if (phase === "failed" || phase === "cancelled" || phase === "offline") {
    return "failed"
  }
  return phase === "finished" ? "done" : "running"
}

const contentOf = (a: PrintActivity) => ({
  title: a.name,
  line: [plate(a.file), a.layers > 0 ? `${a.layer}/${a.layers}` : ""].filter(Boolean).join(" · "),
  progress: Math.max(0, Math.min(1, a.percent / 100)),
  ...(a.endsAt === null ? {} : { endsAt: a.endsAt }),
})

/** Through the core at `url` (its root, like http://127.0.0.1:4871). */
export const coreActivities = (url: string): LiveActivities => {
  let connected: Promise<Client> | null = null
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      connected ??= (async () => {
        const client = new Client({ name: "printers", version: "1" })
        await client.connect(new StreamableHTTPClientTransport(new URL("/apps", url)))
        return client
      })()
      const client = await connected
      const result = await client.callTool({ name, arguments: args })
      return result.structuredContent
    } catch {
      connected = null
      return null
    }
  }
  /** The space the printer's widget is placed in, when it is. */
  const widgetSpace = async (printer: string) => {
    const placed = decodeWidgets(await call("brain_widgets", {}))
    return placed._tag === "Some"
      ? (placed.value.widgets.find((w) => w.app === "printers" && w.name === `printer-${printer}`)
          ?.space ?? undefined)
      : undefined
  }
  return {
    start: async (key, a, sent) => {
      const space = sent ?? (await widgetSpace(a.printer))
      await call("iphone_live_activity_start", {
        id: idOf(key),
        template: "progress",
        ...contentOf(a),
        ...(space === undefined ? {} : { space }),
      })
    },
    update: async (key, a) => {
      await call("iphone_live_activity_update", {
        id: idOf(key),
        ...contentOf(a),
        state: stateOf(a.phase),
      })
    },
    end: async (key, a) => {
      await call("iphone_live_activity_end", {
        id: idOf(key),
        ...contentOf(a),
        state: stateOf(a.phase) === "failed" ? "failed" : "done",
      })
    },
  }
}
