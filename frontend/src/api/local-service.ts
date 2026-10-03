import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, readFreshRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionContext, ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '退回']

const STATIONHOUSE_KEY = 'stationhouse'
const CALIBRATION_KEY = 'calibration'
const STATION_KEY = 'station'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 旧记录缺维护单位时按站点归属兼容：用站点编号找到监测站点，取它的管理单位。
// 只在读取、导出时补齐展示，不回写存储，旧数据保持原样。
function resolveMaintenanceUnit(row: EntryRow): string {
  const unit = String(row['维护单位'] ?? '').trim()
  if (unit !== '') {
    return unit
  }
  const stationCode = String(row['站点编号'] ?? '').trim()
  if (stationCode === '') {
    return ''
  }
  const station = listRows(STATION_KEY).find(
    (item) => String(item['站点编号'] ?? '').trim() === stationCode,
  )
  return String(station?.['管理单位'] ?? '').trim()
}

function presentRows(key: string, rows: EntryRow[]): EntryRow[] {
  if (key !== STATIONHOUSE_KEY) {
    return rows
  }
  return rows.map((row) => ({ ...row, 维护单位: resolveMaintenanceUnit(row) }))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(presentRows(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function nowLabel(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date} ${time}`
}

function nextCalibrationCode(rows: EntryRow[]): string {
  const maxSerial = rows.reduce((max, item) => {
    const match = /^CALI-(\d+)$/.exec(String(item['记录编号'] ?? ''))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `CALI-${String(maxSerial + 1).padStart(4, '0')}`
}

// 验收通过后同步新增仪器检定待办；按来源维护记录去重，两个终端同时验收也只补一条。
function syncCalibrationTodo(row: EntryRow): string {
  const rows = readFreshRows(CALIBRATION_KEY)
  const existing = rows.find((item) => Number(item['来源维护记录ID']) === Number(row.id))
  if (existing) {
    return String(existing['记录编号'])
  }
  const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const code = nextCalibrationCode(rows)
  const stationCode = String(row['站点编号'] ?? '').trim()
  const todo: EntryRow = {
    id: nextId,
    status: '待送检',
    pending: true,
    abnormal: false,
    记录编号: code,
    仪器编号: `INST-${stationCode || nextId}`,
    仪器名称: `${stationCode || '本站'}站房配套监测仪器`,
    检定单位: resolveMaintenanceUnit(row) || '待指定',
    检定日期: '',
    有效期至: '',
    检定结论: '',
    检定状态: '待送检',
    来源维护记录: String(row['记录编号'] ?? ''),
    来源维护记录ID: Number(row.id),
  }
  saveRows(CALIBRATION_KEY, [...rows, todo])
  return code
}

// 站房维护验收：越权校验、并发只落一个结论、结算费用快照、检定待办联动都在这里。
function acceptStationhouse(meta: ModuleMeta, id: number, context: ActionContext): ActionResult {
  // 先重读存储再比对：另一个终端若已抢先验收，这里直接拒掉，保证只落一个结论。
  const rows = readFreshRows(STATIONHOUSE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current !== '已完成') {
    if (current === '已验收') {
      return {
        ok: false,
        message: `${meta.entity}已被「${String(row['验收人'] ?? '另一终端')}」验收，同一记录只落一个验收结论`,
      }
    }
    return { ok: false, message: `${meta.entity}当前状态「${current}」，只有完成施工的记录才能提交验收` }
  }
  const stationId = (context.stationId ?? '').trim()
  const recordStation = String(row['站点编号'] ?? '').trim()
  if (stationId === '' || recordStation !== stationId) {
    return {
      ok: false,
      message: `越权验收被拒绝：记录属于站点「${recordStation || '未知'}」，当前终端验收权限为「${stationId || '未绑定站点'}」`,
    }
  }
  const fee = Number(row['费用支出'])
  const settledFee = Number.isFinite(fee) ? fee : 0
  const operator = (context.operator ?? '').trim() || '未知操作员'
  const updated: EntryRow = {
    ...row,
    status: '已验收',
    pending: false,
    abnormal: false,
    // 费用取数：验收通过时按当前费用支出快照结算；之后费用变更不回溯这条历史结算。
    结算费用: settledFee,
    验收人: operator,
    验收时间: nowLabel(),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(STATIONHOUSE_KEY, next)
  const todoCode = syncCalibrationTodo(updated)
  return {
    ok: true,
    message: `${meta.entity}已通过验收，结算费用 ${settledFee}（历史结算快照，不随后续费用变更重算）；仪器检定待办 ${todoCode} 已同步新增`,
  }
}

// 调整站房维护记录的费用支出：已验收记录只改费用支出，结算费用保持验收时的快照，历史结算不重算。
export function updateMaintenanceFee(id: number, fee: number): ActionResult {
  const meta = moduleMeta(STATIONHOUSE_KEY)
  if (!Number.isFinite(fee) || fee < 0) {
    return { ok: false, message: '费用支出必须是不小于 0 的数字' }
  }
  const rows = readFreshRows(STATIONHOUSE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const next = [...rows]
  next[index] = { ...row, 费用支出: fee }
  saveRows(STATIONHOUSE_KEY, next)
  if (String(row.status) === '已验收') {
    return {
      ok: true,
      message: `费用支出已调整为 ${fee}；该记录已验收，结算费用仍保持 ${String(row['结算费用'] ?? fee)}，历史结算不重算`,
    }
  }
  return { ok: true, message: `费用支出已调整为 ${fee}，验收结算时将按新费用取数` }
}

export function runAction(key: string, id: number, action: string, context: ActionContext = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === STATIONHOUSE_KEY && action === '通过验收') {
    return acceptStationhouse(meta, id, context)
  }
  const rows = readFreshRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前状态「${current}」不能执行「${action}」，只有「${sources.join('」「')}」状态可以，流程不能跳级`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of presentRows(key, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
