/**
 * 振动场萨道夫斯基（Sadovsky）参数单源默认值
 *
 * K（场地系数）与 α（衰减指数）在此唯一定义，blastingManager / 本地模拟器 /
 * useBlasting / 振动场面板均从本模块引用，避免多处字面量漂移。
 * 改动任一默认值都会影响对应层的回退行为，请连同注释一起评审。
 */

/**
 * 场地标定回退（石灰岩/金属矿硬岩现场测振回归 K=90、α=1.58，见文档 3/4 文献）。
 * blastingManager 在事件/后端未提供 K/α 时使用。
 */
export const SADOVSKY_DEFAULT_K = 90
export const SADOVSKY_DEFAULT_ALPHA = 1.58

/**
 * 本地振动模拟器默认（中硬岩近场可视化：K=30 时近爆心 PPV 仍达数十 cm/s（红），
 * 远场衰减至 ~1 cm/s（蓝），呈现"近红→中绿→远蓝"的球面梯度）。
 * LocalVibrationSimulator 与 useBlasting 的会话初始值使用。
 */
export const LOCAL_SIM_DEFAULT_K = 30
export const LOCAL_SIM_DEFAULT_ALPHA = 1.5

/**
 * 文献实测的萨道夫斯基标定集（振动场面板下拉预设，便于用真实场地参数反标定 PPV 场）。
 */
export const SADOSKY_PRESETS = [
  { key: 'preset_default', label: '平台默认 · 中硬岩（K=200, α=1.5）', k: 200, alpha: 1.5 },
  {
    key: 'preset_tunnel_near_xu',
    label: '三棱山隧道近场 r<110m（K=19.3, α=1.082·徐言2020）',
    k: 19.3,
    alpha: 1.082
  },
  {
    key: 'preset_tunnel_far_xu',
    label: '三棱山隧道远场 r>110m（K=1.23, α=0.372·徐言2020）',
    k: 1.23,
    alpha: 0.372
  },
  {
    key: 'preset_open_300_yan',
    label: '露天铁矿 300°线（K=165.9, α=1.418·闫常陆2018）',
    k: 165.9,
    alpha: 1.418
  },
  {
    key: 'preset_open_285_yan',
    label: '露天铁矿 285°线（K=165.8, α=1.476·闫常陆2018）',
    k: 165.8,
    alpha: 1.476
  },
  {
    key: 'preset_open_m30_yan',
    label: '露天铁矿 -30m 平台（K=236.5, α=1.531·闫常陆2018）',
    k: 236.5,
    alpha: 1.531
  }
]
