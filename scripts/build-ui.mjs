import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/ui/entry.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: ['react', 'react/jsx-runtime'],
})
const code = result.outputFiles[0].text
await writeFile('lib/ui-bundle.js', `window.__ModuleLoader__.load({\n  id: 'dsh-workbuddy-manager',\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  },\n});\n`)
