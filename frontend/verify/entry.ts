// 在 Node 里构造浏览器最小环境，再逐项断言站房维护流程。
import { createPinia, setActivePinia } from 'pinia'

// ---- 内存版 localStorage ----
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}
;(globalThis as any).window = {
  localStorage: new MemoryStorage(),
  addEventListener: () => {},
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

setActivePinia(createPinia())

const { runAction } = await import('@/api/local-service')
const {
  runStationhouseAction,
  changeFee,
  resolveUnit,
  actionsFor,
} = await import('@/api/stationhouse-workflow')
const { listRows, resetRows, snapshotRows, commitRows } = await import('@/data/local-store')
const { useSessionStore } = await import('@/stores/session')
const store = useSessionStore()

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.error(`  ❌ ${name} ${detail}`)
  }
}
function reset() {
  resetRows('stationhouse')
  resetRows('calibration')
  resetRows('station')
  store.setTerminal('STAT-0001')
}
function find(id: number) {
  return listRows('stationhouse').find((r) => Number(r.id) === id)!
}
function calibrationCount() {
  return listRows('calibration').length
}

console.log('1) 单向流程：待安排→施工中→已完成→已验收')
reset()
check('待安排可安排维护→施工中', runStationhouseAction(1, '安排维护').ok)
check('记录1现在施工中', find(1).status === '施工中', find(1).status)
check('施工中完工提交验收→已完成', runStationhouseAction(1, '完工提交验收').ok)
check('记录1现在已完成', find(1).status === '已完成')
check('已完成通过验收→已验收', runStationhouseAction(1, '通过验收').ok)
check('记录1现在已验收', find(1).status === '已验收')

console.log('2) 只有完成施工才能提交验收（跳级拒绝）')
reset()
check('待安排不能直接完工提交验收', !runStationhouseAction(1, '完工提交验收').ok)
check('施工中不能直接通过验收', !runStationhouseAction(2, '通过验收').ok)
check('待安排不能直接通过验收', !runStationhouseAction(1, '通过验收').ok)
check('已验收不能再安排维护', !runStationhouseAction(4, '安排维护').ok)
reset()

console.log('3) 验收退回只能回到施工中，不能跳级')
reset()
store.setTerminal('STAT-0002')
check('已完成可验收退回→施工中', runStationhouseAction(3, '验收退回').ok)
check('记录3退回后为施工中', find(3).status === '施工中', find(3).status)
check('施工中不能再验收退回', !runStationhouseAction(3, '验收退回').ok)
check('待安排不能验收退回', !runStationhouseAction(1, '验收退回').ok)
check('退回记录不能跳过完工直接验收', !runStationhouseAction(3, '通过验收').ok)
check('退回后重新完工可再验收', (runStationhouseAction(3, '完工提交验收').ok && runStationhouseAction(3, '通过验收').ok))
store.setTerminal('STAT-0001')
reset()

console.log('4) 费用取数与历史结算不重算')
check('未验收记录可调整费用', changeFee(2, 9999).ok)
check('费用已更新', Number(find(2)['费用支出']) === 9999)
runStationhouseAction(2, '完工提交验收')
runStationhouseAction(2, '通过验收')
check('验收时按最新费用结算', Number(find(2)['结算金额']) === 9999, String(find(2)['结算金额']))
check('已验收后费用变更被拒绝', !changeFee(2, 1).ok)
check('历史结算金额保持不变', Number(find(2)['结算金额']) === 9999)

console.log('5) 旧记录缺维护单位：按站点归属兼容')
reset()
const unit = resolveUnit(find(1)) // SH-0001 无维护单位，站点 STAT-0001 管理单位为赣东北水文监测中心
check('缺失时回退到站点管理单位', unit.unit === '赣东北水文监测中心', unit.unit)
check('标记为回退来源', unit.fallback === true)
const unit2 = resolveUnit(find(2))
check('有维护单位时直接取原值', unit2.unit === '宏远房建工程队' && unit2.fallback === false)

console.log('6) 越权验收非本站记录要拒绝')
reset()
store.setTerminal('STAT-0001')
check('非本站记录验收通过被拒绝', !runStationhouseAction(3, '通过验收').ok) // SH-0003 属 STAT-0002
check('非本站记录验收退回被拒绝', !runStationhouseAction(3, '验收退回').ok)
check('记录状态未被改动', find(3).status === '已完成')
check('UI 不暴露越权验收动作', actionsFor(find(3)).every((a) => !(!a.disabled && (a.action === '通过验收' || a.action === '验收退回'))))
store.setTerminal('STAT-0002')
check('切到归属终端可验收', runStationhouseAction(3, '通过验收').ok)
check('验收记录上留有终端痕迹', String(find(3)['验收终端']) === 'STAT-0002')
store.setTerminal('STAT-0001')

console.log('7) 验收完成后仪器检定待办同步新增')
reset()
const before = calibrationCount()
runStationhouseAction(2, '完工提交验收')
const r = runStationhouseAction(2, '通过验收')
check(r.message, r.ok)
check('检定记录数 +1', calibrationCount() === before + 1, `${calibrationCount()} vs ${before}`)
const todo = listRows('calibration').find((x) => String(x['来源维护记录']) === 'SH-0002')
check('待办状态为待送检', !!todo && todo.status === '待送检', JSON.stringify(todo))
check('待办关联站点一致', !!todo && String(todo['所属站点']) === 'STAT-0001')

console.log('8) 检定待办幂等：退回再验收不重复新增')
reset()
const base = calibrationCount()
runStationhouseAction(3, '验收退回', '需整改') // STAT-0002 记录
store.setTerminal('STAT-0002')
runStationhouseAction(3, '完工提交验收')
runStationhouseAction(3, '通过验收')
store.setTerminal('STAT-0001')
const linked = listRows('calibration').filter((x) => String(x['来源维护记录']) === 'SH-0003').length
check('只产生一条联动待办', linked === 1, String(linked))

console.log('9) 两个终端同时验收只落一个结论（CAS）')
reset()
store.setTerminal('STAT-0001')
// 模拟终端B：在A读取之后抢先把记录推进到已验收（同一存储上构造竞态）
runStationhouseAction(2, '完工提交验收')
const rowsA = JSON.stringify(listRows('stationhouse')) // A 端拿到的基线
// B 端直接通过验收并落库
const commitB = runStationhouseAction(2, '通过验收')
check('先到终端验收成功', commitB.ok)
// A 端拿着旧基线尝试提交（通过手工触发一次会失败的路径：状态已变）
const staleAttempt = runStationhouseAction(2, '通过验收')
check('后到终端结论被拒绝（记录已是终态）', !staleAttempt.ok)
check('最终只有一条验收结论', find(2).status === '已验收' && listRows('calibration').filter((x) => String(x['来源维护记录']) === 'SH-0002').length === 1)
void rowsA

// 纯 CAS 竞态：两个终端持同一基线，各自构造「验收通过 + 检定待办」事务，先后提交
store.setTerminal('STAT-0002')
runStationhouseAction(3, '验收退回')
runStationhouseAction(3, '完工提交验收') // 回到已完成
const baseline = snapshotRows('stationhouse')
const calBaseline = snapshotRows('calibration')
const buildPatch = (terminal: string) => {
  const all = JSON.parse(baseline)
  const idx = all.findIndex((x: any) => Number(x.id) === 3)
  all[idx] = { ...all[idx], status: '已验收', pending: false, 验收终端: terminal, 结算金额: 2600, 结算时间: '2026-10-03' }
  return { key: 'stationhouse', rows: all, baseline }
}
const first = commitRows([buildPatch('STAT-0002')])
const second = commitRows([
  { key: 'stationhouse', rows: JSON.parse(baseline).map((x: any) => x.id === 3 ? { ...x, status: '已验收', 验收终端: 'STAT-0001' } : x), baseline },
  { key: 'calibration', rows: JSON.parse(calBaseline), baseline: calBaseline },
])
check('第一个终端事务提交成功', first === true)
check('第二个终端事务被 CAS 拒绝', second === false)
check('结论只保留第一个终端', String(find(3)['验收终端']) === 'STAT-0002')
store.setTerminal('STAT-0001')

console.log('9b) 存储为空（首次操作）时基线也能对上，流程可正常提交')
;(globalThis as any).window.localStorage.clear()
const fresh = runStationhouseAction(1, '安排维护')
check('首次安排维护成功（无假冲突）', fresh.ok, fresh.message)
reset()

console.log('10) 旧状态「已安排」迁移为「施工中」（独立进程，见 verify-migration）')

console.log('11) 通用动作入口同样受状态机约束')
reset()
check('通用入口也拒绝跳级', !runAction('stationhouse', 1, '完工提交验收').ok)
check('通用入口允许合法首步', runAction('stationhouse', 1, '安排维护').ok)
check('验收退回不被标记为异常', (() => {
  store.setTerminal('STAT-0002')
  const rr = runStationhouseAction(3, '验收退回')
  store.setTerminal('STAT-0001')
  return rr.ok && find(3).abnormal === false
})())

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
