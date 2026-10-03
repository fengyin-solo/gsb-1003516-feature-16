import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

// 旧版站房维护流程里的「已安排」已并入「施工中」，读出旧档时顺手迁移，单向流程不留历史断点。
const LEGACY_STATUS: Record<string, Record<string, string>> = {
  stationhouse: { 已安排: '施工中' },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 兼容旧数据：当前只有站房维护存在状态收敛，映射不到就原样保留。
function normalize(raw: Record<string, EntryRow[]>): {
  data: Record<string, EntryRow[]>
  changed: boolean
} {
  const data = { ...raw }
  let changed = false
  for (const key of Object.keys(LEGACY_STATUS)) {
    const rows = data[key]
    if (!Array.isArray(rows)) {
      continue
    }
    let keyChanged = false
    const migrated = rows.map((row) => {
      const target = LEGACY_STATUS[key][String(row.status)]
      if (!target) {
        return row
      }
      keyChanged = true
      return { ...row, status: target, pending: target !== '已验收' }
    })
    if (keyChanged) {
      data[key] = migrated
      changed = true
    }
  }
  return { data, changed }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const { data, changed } = normalize(parsed)
    const merged = { ...fallback, ...data }
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 其他终端（浏览器标签页）改了数据就作废内存缓存，下次读取以存储里的最新结论为准。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 取某模块当前落库内容的快照，和 commitRows 配合做乐观锁：动作执行前后快照不一致即判定被别的终端抢改。
// 口径与 commitRows 完全一致：存储缺该模块时以种子数据为基线（首次提交也能对得上）。
export function snapshotRows(key: string): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return JSON.stringify(clone(listRows(key)))
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const parsed = raw ? (JSON.parse(raw) as Record<string, EntryRow[]>) : {}
  return JSON.stringify(parsed[key] ?? clone(SEED_ROWS[key] ?? []))
}

export type KeyedPatch = {
  key: string
  rows: EntryRow[]
  baseline: string
}

// 多模块原子提交：任一模块快照对不上就整体放弃（典型场景：两个终端同时验收同一条记录）。
// 一次 localStorage 写入，保证站房验收结论与仪器检定待办要么一起落、要么都不落。
export function commitRows(patches: KeyedPatch[]): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let parsed: Record<string, EntryRow[]> = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    } catch {
      return false
    }
  }
  for (const patch of patches) {
    const current = JSON.stringify(parsed[patch.key] ?? clone(SEED_ROWS[patch.key] ?? []))
    if (current !== patch.baseline) {
      return false
    }
  }
  const next = { ...clone(SEED_ROWS), ...parsed }
  for (const patch of patches) {
    next[patch.key] = patch.rows
  }
  // 与 readStorage 保持同一口径：首次提交也把种子模块一并落库，后续提交读到的就是完整全量。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  const { data } = normalize(next)
  cache = { ...clone(SEED_ROWS), ...data }
  return true
}

export function invalidateCache(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}
