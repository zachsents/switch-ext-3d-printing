// The printer's card: implicit FTPS on port 990, user bblp, the access code as the password, as
// the CLI's ftp_session. The FTP root is the microSD card; plates go in its root.
import { renameSync } from "node:fs"
import { Client } from "basic-ftp"

import { readConnection } from "./config.ts"

export interface CardFile {
  readonly name: string
  readonly size: number
  /** When it was written, in ms, if the printer says. */
  readonly at: number | null
}

export interface Card {
  /** The files in a folder of the card, its root by default. */
  readonly list: (id: string, folder?: string) => Promise<CardFile[]>
  readonly upload: (id: string, local: string, name: string) => Promise<void>
  /** A file off the card, written through a .part beside `local`. */
  readonly download: (id: string, remote: string, local: string) => Promise<void>
}

const session = async <A>(id: string, work: (client: Client) => Promise<A>): Promise<A> => {
  const conn = readConnection(id)
  const client = new Client(30_000)
  try {
    await client.access({
      host: conn.host,
      port: 990,
      user: "bblp",
      password: conn.accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    })
    return await work(client)
  } finally {
    client.close()
  }
}

export const ftpsCard: Card = {
  list: async (id, folder = "/") =>
    await session(id, async (client) => {
      const all = await client.list(folder)
      return all
        .filter((f) => f.isFile)
        .map((f) => ({ name: f.name, size: f.size, at: f.modifiedAt?.getTime() ?? null }))
    }),
  upload: async (id, local, name) => {
    await session(id, async (client) => {
      await client.uploadFrom(local, `/${name}`)
    })
  },
  download: async (id, remote, local) => {
    await session(id, async (client) => {
      await client.downloadTo(`${local}.part`, remote)
    })
    renameSync(`${local}.part`, local)
  },
}
