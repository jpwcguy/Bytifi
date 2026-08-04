import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

await build({
  entryPoints: ['bin/bytifi.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/bytifi-bundle.cjs',
  // Collapse `true ? injected : createRequire(import.meta.url)` so the Windows
  // pkg snapshot never evaluates import.meta.url (undefined → ERR_INVALID_ARG_VALUE).
  minifySyntax: true,
  treeShaking: true,
  define: {
    __BYTIFI_VERSION__: JSON.stringify(pkg.version),
  },
  logOverride: {
    'empty-import-meta': 'silent',
  },
})
