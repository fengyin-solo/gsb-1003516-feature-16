// 旧数据迁移独立验证：localStorage 里预先放入「已安排」旧记录，首次读取应自动迁移为「施工中」。
import { build } from 'esbuild'

const prelude = `
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
}
const storage = new MemoryStorage()
storage.setItem('hydrology-monitor-station:entries', JSON.stringify({
  stationhouse: [
    { id: 99, status: '已安排', pending: true, abnormal: false, 记录编号: 'OLD-1', 站点编号: 'STAT-0001' },
    { id: 98, status: '待安排', pending: true, abnormal: false, 记录编号: 'OLD-2', 站点编号: 'STAT-0001' },
  ],
}))
globalThis.window = { localStorage: storage, addEventListener: () => {} }
`

const bundle = await build({
  stdin: {
    contents: `
      import { listRows } from '@/data/local-store'
      const rows = listRows('stationhouse')
      const a = rows.find((r) => r.id === 99)
      const b = rows.find((r) => r.id === 98)
      const ok = a.status === '施工中' && a.pending === true && b.status === '待安排'
      console.log(ok ? '  ✅ 已安排迁移为施工中，其他状态不动' : '  ❌ 迁移异常: ' + JSON.stringify(rows))
      process.exit(ok ? 0 : 1)
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  alias: { '@': new URL('../src/', import.meta.url).pathname },
  banner: { js: prelude },
})

const { writeFileSync } = await import('node:fs')
writeFileSync('verify/.migration.mjs', bundle.outputFiles[0].text)
await import('./.migration.mjs')
