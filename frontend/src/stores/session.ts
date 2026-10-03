import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    // 当前终端所属站点：站房维护验收按它做越权校验，只能验收本站记录。
    stationId: 'STAT-0001',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setStation(id: string) {
      this.stationId = id
    },
  },
})
