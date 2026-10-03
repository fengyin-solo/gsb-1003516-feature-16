// 站房维护流程端到端验证：内存 localStorage + 桩 window，直接跑真实的数据层与流程服务。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const bundle = await build({
  entryPoints: ['verify/entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  alias: { '@': new URL('../src/', import.meta.url).pathname },
})
const code = bundle.outputFiles[0].text
writeFileSync('verify/.bundle.mjs', code)
await import('./.bundle.mjs')
