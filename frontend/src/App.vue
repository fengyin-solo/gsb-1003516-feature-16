<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">水文监测站网管理系统</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。</span>
        <span class="head-user">
          <label class="terminal-pick">
            当前终端
            <select
              :value="store.terminal.code"
              title="终端固定归属一个站点，验收只对本站记录生效"
              @change="store.setTerminal(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in terminals" :key="item.code" :value="item.code">
                {{ item.name }}（{{ item.code }}）
              </option>
            </select>
          </label>
          当前值班：{{ store.operator }} · {{ store.shiftLabel }}
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { TERMINALS, useSessionStore } from '@/stores/session'

const store = useSessionStore()
const terminals = TERMINALS

const navItems = [{ label: "运营概览", path: "/" }, { label: "监测站点", path: "/station" }, { label: "水位监测", path: "/waterlevel" }, { label: "流量监测", path: "/discharge" }, { label: "雨量观测", path: "/rainfall" }, { label: "水质检测", path: "/waterquality" }, { label: "断面测量", path: "/crosssection" }, { label: "遥测设备", path: "/telemetry" }, { label: "数据整编", path: "/compilation" }, { label: "预警阈值", path: "/warning" }, { label: "地下水观测", path: "/groundwater" }, { label: "蒸发观测", path: "/evaporation" }, { label: "测流缆道", path: "/cableway" }, { label: "泥沙监测", path: "/sediment" }, { label: "通讯系统", path: "/communication" }, { label: "站房维护", path: "/stationhouse" }, { label: "仪器检定", path: "/calibration" }, { label: "巡检记录", path: "/inspection" }, { label: "测报方案", path: "/plan" }]
</script>

<style scoped>
.terminal-pick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
}
.terminal-pick select {
  padding: 2px 4px;
}
</style>
