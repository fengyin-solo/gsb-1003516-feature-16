import { defineStore } from 'pinia'

// 终端即登录端：每个终端固定归属一个站点，验收类动作只能落在归属站点的记录上。
export type Terminal = {
  code: string
  name: string
}

export const TERMINALS: Terminal[] = [
  { code: 'STAT-0001', name: '桃溪水文站终端' },
  { code: 'STAT-0002', name: '柳湾水文站终端' },
  { code: 'STAT-0003', name: '石梁河水文站终端' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
    terminal: TERMINALS[0] as Terminal,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setTerminal(code: string) {
      const found = TERMINALS.find((item) => item.code === code)
      if (found) {
        this.terminal = found
      }
    },
  },
})
