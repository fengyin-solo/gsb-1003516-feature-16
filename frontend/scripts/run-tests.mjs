// 逻辑测试运行器：把 tests/ 下的 .mts 用 esbuild 打包成 ESM 后逐个用 node 执行。
// 纯前端仓库没有后端可测，这里直接对 src/api/local-service.ts 的业务规则做冒烟验证。
import { build } from 'esbuild'
import { readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const testsDir = join(root, 'tests')
const outDir = mkdtempSync(join(tmpdir(), 'stationhouse-tests-'))

const files = readdirSync(testsDir).filter((name) => name.endsWith('.mts'))
if (files.length === 0) {
  console.log('tests/ 下没有 .mts 测试文件')
  process.exit(0)
}

let failed = 0
for (const file of files) {
  const outfile = join(outDir, file.replace(/\.mts$/, '.mjs'))
  await build({
    entryPoints: [join(testsDir, file)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { '@': join(root, 'src') },
    outfile,
    logLevel: 'warning',
  })
  console.log(`\n===== ${file} =====`)
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
  }
}

process.exit(failed === 0 ? 0 : 1)
