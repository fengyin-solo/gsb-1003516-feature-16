import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitRows,
  invalidateCache,
  listRows,
  snapshotRows,
  type KeyedPatch,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const STATIONHOUSE = 'stationhouse'
const CALIBRATION = 'calibration'
const STATION = 'station'

// 单向流程：待安排 → 施工中 → 已完成 → 已验收；退回只从已完成回到施工中。
const TRANSITIONS: Record<string, string[]> = {
  安排维护: ['待安排'],
  完工提交验收: ['施工中'],
  验收退回: ['已完成'],
  通过验收: ['已完成'],
}
const TARGETS: Record<string, string> = {
  安排维护: '施工中',
  完工提交验收: '已完成',
  验收退回: '施工中',
  通过验收: '已验收',
}
// 只有验收动作需要校验终端归属：安排、施工、完工由维护侧推进，验收才是本站把关。
const SCOPE_ACTIONS = new Set(['通过验收', '验收退回'])
const FINAL_STATUS = '已验收'

export type StationhouseRow = EntryRow & {
  记录编号?: string
  站点编号?: string
  维护单位?: string
  费用支出?: number | string
  结算金额?: number
  结算时间?: string
  验收终端?: string
  验收人?: string
  退回原因?: string
  检定待办?: string
}

function meta() {
  const found = MODULE_BY_KEY.get(STATIONHOUSE)
  if (!found) {
    throw new Error('没有登记名为 stationhouse 的业务模块')
  }
  return found
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 旧记录可能没填维护单位：按站点编号回退到站点的管理单位，仍查不到才给占位，保证费用与验收单据有责任主体。
export function resolveUnit(row: StationhouseRow): { unit: string; fallback: boolean } {
  const direct = String(row['维护单位'] ?? '').trim()
  if (direct) {
    return { unit: direct, fallback: false }
  }
  const stationCode = String(row['站点编号'] ?? '').trim()
  const station = listRows(STATION).find((item) => String(item['站点编号'] ?? '') === stationCode)
  const owner = station ? String(station['管理单位'] ?? '').trim() : ''
  if (owner) {
    return { unit: owner, fallback: true }
  }
  return { unit: '未明确维护单位', fallback: true }
}

function feeOf(row: StationhouseRow): number {
  const value = Number(row['费用支出'])
  return Number.isFinite(value) ? value : 0
}

function isOwned(row: StationhouseRow, terminalCode: string): boolean {
  return String(row['站点编号'] ?? '').trim() === terminalCode
}

// 页面按当前状态决定可显示的动作；越权的验收动作直接不暴露，兜底再在提交时拒绝。
export function actionsFor(row: EntryRow): { action: string; disabled: boolean; hint: string }[] {
  const session = useSessionStore()
  const status = String(row.status)
  const source: EntryRow = row
  return (
    Object.keys(TRANSITIONS)
      .filter((action) => TRANSITIONS[action].includes(status))
      .map((action) => {
        const needScope = SCOPE_ACTIONS.has(action)
        const owned = isOwned(source, session.terminal.code)
        if (needScope && !owned) {
          return { action, disabled: true, hint: `仅 ${String(source['站点编号'] ?? '')} 归属终端可验收` }
        }
        return { action, disabled: false, hint: '' }
      })
  )
}

function appendCalibrationTodo(
  calibration: EntryRow[],
  record: StationhouseRow,
  unit: string,
): EntryRow[] {
  const sourceCode = String(record['记录编号'] ?? '')
  // 幂等：同一条站房维护只同步一次检定待办，重复验收、退回再验收都不会产生第二条。
  const exists = calibration.some((row) => String(row['来源维护记录'] ?? '') === sourceCode)
  if (exists) {
    return calibration
  }
  const nextId = calibration.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const todo: EntryRow = {
    id: nextId,
    status: '待送检',
    pending: true,
    abnormal: false,
    记录编号: `CALI-SH-${sourceCode || String(nextId).padStart(4, '0')}`,
    仪器编号: `待指派-${sourceCode || nextId}`,
    仪器名称: `站房维护验收联动检定（${sourceCode}）`,
    检定单位: unit,
    检定日期: '',
    有效期至: '',
    检定结论: '',
    检定状态: '待送检',
    来源维护记录: sourceCode,
    所属站点: String(record['站点编号'] ?? ''),
  }
  return [...calibration, todo]
}

export function runStationhouseAction(
  id: number,
  action: string,
  reason = '',
): ActionResult {
  const entity = meta().entity
  const allowed = TRANSITIONS[action]
  if (!allowed) {
    return { ok: false, message: `${entity}没有登记「${action}」这个动作` }
  }
  const session = useSessionStore()

  // 先在缓存视角做全部业务校验，最后才走 CAS 落库，避免留下半成品。
  const rows = listRows(STATIONHOUSE) as StationhouseRow[]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${entity}` }
  }
  const record = rows[index]
  const current = String(record.status)
  if (!allowed.includes(current)) {
    return {
      ok: false,
      message: `当前是「${current}」，不能执行「${action}」，请按 待安排→施工中→已完成→已验收 的顺序流转`,
    }
  }
  const target = TARGETS[action]
  const { unit } = resolveUnit(record)

  // 先判流程再判权限：状态不对时提示按顺序流转，状态对但终端不对时才报越权。
  if (SCOPE_ACTIONS.has(action) && !isOwned(record, session.terminal.code)) {
    return {
      ok: false,
      message: `越权拒绝：当前终端归属 ${session.terminal.code}，不能验收站点 ${String(
        record['站点编号'] ?? '',
      )} 的记录`,
    }
  }

  const updated: StationhouseRow = {
    ...record,
    status: target,
    pending: target !== FINAL_STATUS,
    abnormal: false,
    维护单位: unit,
  }

  if (action === '通过验收') {
    // 结算口径：验收通过瞬间取最新费用做结算快照；之后费用再变更不回头重算历史结算。
    updated['结算金额'] = feeOf(record)
    updated['结算时间'] = today()
    updated['验收终端'] = session.terminal.code
    updated['验收人'] = session.operator
    updated['退回原因'] = ''
    updated['检定待办'] = '已同步'
  } else if (action === '验收退回') {
    // 退回只回到施工中，不能改判成其他状态，也不允许越级退回。
    updated['退回原因'] = reason || '验收不通过，退回施工整改'
    updated['验收终端'] = session.terminal.code
    updated['验收人'] = session.operator
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  const stationhousePatch: KeyedPatch = {
    key: STATIONHOUSE,
    rows: nextRows,
    baseline: snapshotRows(STATIONHOUSE),
  }

  const patches: KeyedPatch[] = [stationhousePatch]
  if (action === '通过验收') {
    const calibration = listRows(CALIBRATION)
    const nextCalibration = appendCalibrationTodo(calibration, updated, unit)
    if (nextCalibration !== calibration) {
      patches.push({
        key: CALIBRATION,
        rows: nextCalibration,
        baseline: snapshotRows(CALIBRATION),
      })
    }
  }

  // 乐观锁：任一快照对不上就整体放弃，两个终端同时验收只有一个结论能落下。
  const committed = commitRows(patches)
  if (!committed) {
    invalidateCache()
    return {
      ok: false,
      message: '数据已被其他终端改动，本次操作未生效，请刷新后查看最新结论',
    }
  }

  if (action === '通过验收') {
    return { ok: true, message: `验收通过，结算金额 ${updated['结算金额']} 元，仪器检定待办已同步新增` }
  }
  if (action === '验收退回') {
    return { ok: true, message: '已退回施工，整改完成后需重新完工提交验收' }
  }
  return { ok: true, message: `${entity}已${action}，当前状态「${target}」` }
}

// 费用变更：未验收记录直接改原费用，验收时按最新值取数；已验收记录的结算快照冻结不动。
export function changeFee(id: number, fee: number): ActionResult {
  const entity = meta().entity
  if (!Number.isFinite(fee) || fee < 0) {
    return { ok: false, message: '费用支出必须是不小于 0 的数字' }
  }
  const rows = listRows(STATIONHOUSE) as StationhouseRow[]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${entity}` }
  }
  const record = rows[index]
  if (String(record.status) === FINAL_STATUS) {
    return {
      ok: false,
      message: `记录已验收并按 ${record['结算金额'] ?? feeOf(record)} 元结算，历史结算不再重算`,
    }
  }
  const updated: StationhouseRow = { ...record, 费用支出: fee }
  const nextRows = [...rows]
  nextRows[index] = updated
  const committed = commitRows([
    { key: STATIONHOUSE, rows: nextRows, baseline: snapshotRows(STATIONHOUSE) },
  ])
  if (!committed) {
    invalidateCache()
    return {
      ok: false,
      message: '数据已被其他终端改动，费用未调整，请刷新后重试',
    }
  }
  return { ok: true, message: `费用已调整为 ${fee} 元，将在验收通过时按此金额结算` }
}
