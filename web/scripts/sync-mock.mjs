// Copies the contract fixture docs/mock-response.json into web/lib so the app can
// import it (Next.js does not resolve files outside web/). docs/ stays the source;
// the copy is git-ignored and refreshed before every dev, build and type check.
import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, "../../docs/mock-response.json")
const target = resolve(here, "../lib/generated/mock-response.json")

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log("Synced docs/mock-response.json -> web/lib/generated/mock-response.json")
