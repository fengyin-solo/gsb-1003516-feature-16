<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">
          待安排 → 施工中 → 已完成 → 已验收 单向流转；只有完工才能提交验收，验收退回只回到施工中，不允许跳级。
        </p>
      </div>
      <div class="page-actions">
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
            <template v-if="column === '维护单位'">
              {{ unitOf(row).unit }}
              <span v-if="unitOf(row).fallback" class="fallback-tag" title="旧记录缺少维护单位，按站点归属补全">站点归属补全</span>
            </template>
            <template v-else-if="column === '费用支出'">{{ Number(row[column]) || 0 }}</template>
            <template v-else-if="column === '结算金额'">
              <span v-if="row[column] !== undefined">{{ row[column] }}（{{ row['结算时间'] }}）</span>
              <span v-else class="muted-text">验收时结算</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.status === '已完成' && !isOwned(row)" class="muted-text">·非本站记录</span>
            <span v-if="row['退回原因']" class="return-reason" :title="String(row['退回原因'])">退回整改</span>
          </td>
          <td class="row-actions">
            <template v-for="entry in actionsFor(row)" :key="entry.action">
              <button
                class="link"
                type="button"
                :disabled="entry.disabled"
                :title="entry.hint"
                @click="runAction(entry.action, row)"
              >
                {{ entry.action }}
              </button>
            </template>
            <button
              v-if="row.status !== '已验收'"
              class="link"
              type="button"
              @click="adjustFee(row)"
            >
              调整费用
            </button>
            <span v-if="!actionsFor(row).length && row.status === '已验收'" class="muted-text">流程闭环</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  actionsFor,
  changeFee,
  resolveUnit,
  runStationhouseAction,
} from '@/api/stationhouse-workflow'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('stationhouse')
const session = useSessionStore()
// 费用取数沿用原「费用支出」字段，另加「结算金额」快照列，验收后历史结算不再被费用变更改动。
const columns = [
  '记录编号',
  '站点编号',
  '维护类型',
  '维护内容',
  '维护单位',
  '维护日期',
  '费用支出',
  '结算金额',
  '维护状态',
]
const statuses = ['待安排', '施工中', '已完成', '已验收']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['记录编号', '站点编号', '维护类型']

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const accepted = rows.value.filter((row) => String(row.status) === '已验收')
  return [
    { label: '待维护项数', value: rows.value.filter((row) => row.status === '待安排').length },
    { label: '施工中项数', value: rows.value.filter((row) => row.status === '施工中').length },
    {
      label: '本月已验收',
      value: accepted.filter((row) => String(row['结算时间'] ?? '').startsWith(currentMonth)).length,
    },
    {
      label: '累计结算（元）',
      value: accepted.reduce((sum, row) => sum + (Number(row['结算金额']) || 0), 0),
    },
  ]
})

function isOwned(row: EntryRow): boolean {
  return String(row['站点编号'] ?? '') === session.terminal.code
}

function unitOf(row: EntryRow) {
  return resolveUnit(row)
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
  let reason = ''
  if (action === '验收退回') {
    reason = window.prompt('请填写验收退回原因（退回后记录回到施工中）', '验收不通过，退回整改') ?? ''
    if (reason === '') {
      return
    }
  }
  const result = runStationhouseAction(Number(row.id), action, reason)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function adjustFee(row: EntryRow) {
  errorMessage.value = ''
  const input = window.prompt('调整费用支出（元），验收通过时按最新费用结算', String(row['费用支出'] ?? 0))
  if (input === null) {
    return
  }
  const fee = Number(input)
  const result = changeFee(Number(row.id), fee)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.fallback-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  font-size: 11px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 999px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.return-reason {
  margin-left: 6px;
  padding: 0 6px;
  font-size: 11px;
  color: #b42318;
  background: #fee4e2;
  border-radius: 999px;
}
.link:disabled {
  color: #b6bfcc;
  cursor: not-allowed;
}
</style>
