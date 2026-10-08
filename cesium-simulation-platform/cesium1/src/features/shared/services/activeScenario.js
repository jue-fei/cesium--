/**
 * activeScenario.js —— 平台运行场景（前端单一真源 · 3.2 真机验收修复）
 *
 * 平台同一时刻只运行一个调度场景，但场景名此前在多处各自硬编码：协作事件流
 * （/ws/collab）订阅固定 'ashale'，而调度面板/部署真源实际运行 'large'。后端按
 * **场景分频道**广播协作事件，二者不一致时同场景他端的操作会被静默丢弃，且部署
 * 面板的场景守卫（evt.scenario !== props.scenario）会跳过 opt-in 刷新——即跨终端
 * 协同在真机上不可用。现统一由本常量提供运行场景，协作订阅与调度面板共用。
 *
 * 契约：collabCmps.activeScenario（前端 collabContract.test.js 锁定：协作订阅与
 * 调度面板必须同源引用本常量，不得各自硬编码）。
 */
export const ACTIVE_SCENARIO = 'large'
