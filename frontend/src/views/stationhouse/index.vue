<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">
          待安排 → 已安排 → 施工中 → 已完成 → 已验收单向流转，验收退回只回施工中；验收通过后按费用支出快照结算并同步新增仪器检定待办。
        </p>
      </div>
      <div class="page-actions">
        <label class="station-scope">
          当前终端站点
          <select v-model="session.stationId">
            <option v-for="code in stationOptions" :key="code" :value="code">{{ code }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记站房维护记录</button>
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '费用支出' && editingFeeId === Number(row.id)" class="fee-editor">
              <input v-model="editingFeeValue" class="fee-input" type="number" min="0" step="0.01" />
              <button class="link" type="button" @click="confirmFeeEdit">保存</button>
              <button class="link" type="button" @click="cancelFeeEdit">取消</button>
            </span>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="startFeeEdit(row)">调整费用</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  updateMaintenanceFee,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('stationhouse')
const columns = [...meta.fields, '结算费用', '验收人']
const actions = meta.actions
const statuses = meta.statuses
const stats = [{ "label": "待维护项数", "value": 0 }, { "label": "施工中项数", "value": 0 }, { "label": "本月已验收", "value": 0 }]

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stationOptions = ref<string[]>([])
const editingFeeId = ref<number | null>(null)
const editingFeeValue = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 按元数据里登记的前置状态过滤按钮，能不能执行仍由 local-service 最终校验。
function actionsFor(row: EntryRow): string[] {
  return actions.filter((action) => {
    const sources = meta.actionSources?.[action]
    return !sources || sources.includes(String(row.status))
  })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '站房维护记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: session.operator,
    stationId: session.stationId,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  noticeMessage.value = result.message
  reload()
}

function startFeeEdit(row: EntryRow) {
  editingFeeId.value = Number(row.id)
  editingFeeValue.value = String(row['费用支出'] ?? '')
}

function cancelFeeEdit() {
  editingFeeId.value = null
}

function confirmFeeEdit() {
  if (editingFeeId.value === null) {
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = updateMaintenanceFee(editingFeeId.value, Number(editingFeeValue.value))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  editingFeeId.value = null
  reload()
}

function loadStationOptions() {
  const codes = listEntries('station').items
    .map((row) => String(row['站点编号'] ?? '').trim())
    .filter((code) => code !== '')
  stationOptions.value = codes
  if (!codes.includes(session.stationId)) {
    session.setStation(codes[0] ?? '')
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

onMounted(() => {
  loadStationOptions()
  reload()
})
</script>
