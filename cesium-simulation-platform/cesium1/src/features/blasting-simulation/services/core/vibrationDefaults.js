/**
 * 振动场萨道夫斯基（Sadovsky）参数默认值（前端兜底层）
 *
 * 数据真源已后端化：文献标定集（原 SADOSKY_PRESETS 6 条，徐言2020/闫常陆2018）
 * 与场地标定回退 K/α 的单源在后端 backend-py/config/blasting_sadosky.json，
 * 经 GET /api/blasting/sadosky-presets 下发（振动场面板下拉运行时拉取一次）。
 *
 * 本文件仅保留两类"留在前端"的最小常量：
 *  - LOCAL_SIM_DEFAULT_K/α：本地模拟器可视化默认（平台展示用途，非标定数据，按设计保留前端）；
 *  - SADOVSKY_DEFAULT_K/α：事件/后端未提供 K/α 时的回退值——真源在后端
 *    blasting_sadosky.json 的 default 字段（随 /sadosky-presets 一并下发），
 *    此处为无网/后端未启动场景的兜底，修改默认值请以后端 JSON 为准并两端同步。
 * 改动任一兜底值都会影响对应层的回退行为，请连同注释一起评审。
 */

/**
 * 场地标定回退（石灰岩/金属矿硬岩现场测振回归 K=90、α=1.58，见文档 3/4 文献）。
 * blastingManager 在事件/后端未提供 K/α 时使用。
 * 【兜底常量】真源在后端 blasting_sadosky.json default 字段，两端需同步修改。
 */
export const SADOVSKY_DEFAULT_K = 90
export const SADOVSKY_DEFAULT_ALPHA = 1.58

/**
 * 本地振动模拟器默认（中硬岩近场可视化：K=30 时近爆心 PPV 仍达数十 cm/s（红），
 * 远场衰减至 ~1 cm/s（蓝），呈现"近红→中绿→远蓝"的球面梯度）。
 * LocalVibrationSimulator 与 useBlasting 的会话初始值使用。
 * 【平台可视化默认】非标定数据，按设计保留在前端。
 */
export const LOCAL_SIM_DEFAULT_K = 30
export const LOCAL_SIM_DEFAULT_ALPHA = 1.5
