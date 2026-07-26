import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

await build({
  entryPoints: ['bin/bytifi.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/bytifi-bundle.cjs',
  define: {
    __BYTIFI_VERSION__: JSON.stringify(pkg.version),
  },
})
