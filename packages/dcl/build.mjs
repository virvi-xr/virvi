import { build } from 'esbuild'
import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  // ~system/* modules are provided by the Decentraland runtime; URL/XMLHttpRequest
  // polyfills live in @virvixr/client (ensureNetworkPolyfills) and are bundled in
  external: ['@dcl/sdk', '@dcl/sdk/*', '@dcl/ecs', '@dcl/ecs/*', '~system/*'],
  minify: false,
  sourcemap: true,
})

console.log('Built dist/index.js')

// The types get the same treatment as the code: Virvi's workspace packages are inlined, because none of them is on npm
// and a scene's build type-checks this file (test/published-types.test.mjs). Only Decentraland's own modules stay imports.
const types = await rollup({
  input: 'dist/index.d.ts',
  plugins: [dts({ respectExternal: true })],
  external: (id) => /^(@dcl\/|~system\/)/.test(id),
})
await types.write({ file: 'dist/index.d.ts', format: 'es' })
await types.close()

console.log('Built dist/index.d.ts')
