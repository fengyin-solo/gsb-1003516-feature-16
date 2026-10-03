// 逻辑冒烟测试：模拟浏览器 localStorage，验证站房维护单向流程、越权验收、
// 费用快照、检定待办联动与并发只落一个结论。运行方式见 package 脚本外的手工命令。
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
}

const { runAction, updateMaintenanceFee, listEntries } = await import('@/api/local-service')

let failures = 0
function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS  ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label} ${detail}`)
  }
}

const KEY = 'stationhouse'
const ctx = { operator: '值班管理员', stationId: 'STAT-0001' }
const otherCtx = { operator: '值班管理员', stationId: 'STAT-0002' }
const row = (id: number) => listEntries(KEY).items.find((r) => Number(r.id) === id)!

// ---- 单向流程：不能跳级 ----
check('待安排不能直接确认完工', !runAction(KEY, 1, '确认完工', ctx).ok)
check('待安排不能直接通过验收', !runAction(KEY, 1, '通过验收', ctx).ok)
check('待安排不能退回验收', !runAction(KEY, 1, '退回验收', ctx).ok)
check('待安排 -> 安排维护', runAction(KEY, 1, '安排维护', ctx).ok && row(1).status === '已安排')
check('已安排不能确认完工', !runAction(KEY, 1, '确认完工', ctx).ok)
check('已安排 -> 开始施工', runAction(KEY, 1, '开始施工', ctx).ok && row(1).status === '施工中')
check('施工中不能通过验收', !runAction(KEY, 1, '通过验收', ctx).ok)
check('施工中 -> 确认完工', runAction(KEY, 1, '确认完工', ctx).ok && row(1).status === '已完成')
check('已完成不能安排维护', !runAction(KEY, 1, '安排维护', ctx).ok)

// ---- 验收退回只回施工 ----
check('已完成 -> 退回验收回施工中', runAction(KEY, 1, '退回验收', ctx).ok && row(1).status === '施工中')
check('退回后标记异常', row(1).abnormal === true)
check('施工中可再确认完工', runAction(KEY, 1, '确认完工', ctx).ok && row(1).status === '已完成')

// ---- 越权验收 ----
const denied = runAction(KEY, 1, '通过验收', otherCtx)
check('他站终端验收本站记录被拒绝', !denied.ok && denied.message.includes('越权'), denied.message)
check('未绑定站点的终端不能验收', !runAction(KEY, 1, '通过验收', { operator: 'x', stationId: '' }).ok)

// ---- 正常验收：结算快照 + 检定待办 ----
const calibBefore = listEntries('calibration').total
const accepted = runAction(KEY, 1, '通过验收', ctx)
check('本站终端验收成功', accepted.ok, accepted.message)
check('验收后状态已验收且不再待办', row(1).status === '已验收' && row(1).pending === false)
check('结算费用按验收时费用支出快照', Number(row(1)['结算费用']) === 12.5, String(row(1)['结算费用']))
check('验收人与验收时间已记录', row(1)['验收人'] === '值班管理员' && String(row(1)['验收时间'] ?? '') !== '')
const calibAfter = listEntries('calibration').total
check('验收后同步新增一条仪器检定待办', calibAfter === calibBefore + 1)
const todo = listEntries('calibration').items.find((r) => Number(r['来源维护记录ID']) === 1)!
check('检定待办状态为待送检且关联来源', !!todo && todo.status === '待送检' && String(todo['记录编号']).startsWith('CALI-'))

// ---- 两个终端同时验收只落一个结论 ----
const second = runAction(KEY, 1, '通过验收', otherCtx) // 另一终端（哪怕换了站点）再验收
check('第二终端重复验收被拒绝', !second.ok && second.message.includes('只落一个验收结论'), second.message)
check('检定待办没有重复新增', listEntries('calibration').total === calibAfter)

// ---- 费用变更不重算历史结算 ----
check('已验收记录费用可调整', runAction(KEY, 5, '安排维护', ctx).ok === false) // 顺便确认终态不可动
const feeResult = updateMaintenanceFee(5, 120)
check('已验收记录调整费用成功', feeResult.ok, feeResult.message)
check('历史结算费用保持 80 不重算', Number(row(5)['结算费用']) === 80 && Number(row(5)['费用支出']) === 120)
check('非法费用被拒绝', !updateMaintenanceFee(5, -1).ok && !updateMaintenanceFee(5, Number('abc')).ok)

// ---- 未完成记录调费后按新费用结算 ----
check('已完成记录调整费用', updateMaintenanceFee(4, 55).ok)
check('按新费用验收结算', runAction(KEY, 4, '通过验收', ctx).ok && Number(row(4)['结算费用']) === 55)

// ---- 维护单位兼容 ----
check('缺维护单位的旧记录按站点归属补齐', String(row(1)['维护单位']) === '监测站点样例1', String(row(1)['维护单位']))
check('已有维护单位的记录保持原值', String(row(2)['维护单位']) === '站房维护样例2')

// ---- 跨终端可见性：外部直接改存储（模拟另一终端写入），动作前必须重读 ----
{
  const raw = store.get('hydrology-monitor-station:entries')!
  const data = JSON.parse(raw) as Record<string, { id: number; status: string }[]>
  data[KEY].find((r) => r.id === 2)!.status = '已完成' // 另一终端把 2 号推到已完成
  store.set('hydrology-monitor-station:entries', JSON.stringify(data))
  const cross = runAction(KEY, 2, '通过验收', otherCtx) // 本终端缓存还是「已安排」
  check('另一终端写入的状态能被本终端看到并验收', cross.ok && row(2).status === '已验收', cross.message)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
