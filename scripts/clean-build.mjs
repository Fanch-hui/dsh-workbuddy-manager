import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// lib contains only compiler output; removing it prevents renamed modules from
// being included in subsequent package builds.
rmSync(fileURLToPath(new URL('../lib', import.meta.url)), { recursive: true, force: true })
