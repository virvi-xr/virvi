import { READ_TOOLS } from './read.js'
import { WRITE_TOOLS } from './write.js'
import { LOCAL_TOOLS } from './local.js'
import type { ToolDef } from './types.js'

/** Every assistant tool, by name. */
export const TOOLS: Record<string, ToolDef<any>> = Object.fromEntries([...READ_TOOLS, ...WRITE_TOOLS, ...LOCAL_TOOLS].map((t) => [t.name, t]))
