"""
地下巷道铲运机(LHD)现场调度仿真引擎

背景：新疆阿舍勒铜矿及“一带一路”海外矿山，超 1500m 深井高应力复杂巷道，
爆破后爆落矿岩散体随机堆积，炮烟浓度高、光线差、定位信号退化，多台铲运机
在狭小巷道协同出矿。

本模块按“四类影响因素”进行结构化仿真，所有数值给出**量纲**与**拟合口径(basis)**，
确保数据不是随机凑数，而是依据矿山与井下装备工程常识合理拟合：

  1. 巷道物理通过性（硬约束）
       - 最小转弯半径 / 巷道曲率
       - 最大爬坡能力 / 巷道坡度
       - 巷道净高 / 净宽（装备尺寸 + 安全间距）
  2. 动态环境与感知（实时扰动）
       - 作业点位定位误差（<0.3m）、行进定位误差（<0.8m）、定位置信度
       - 炮烟与粉尘浓度（炮烟消减技术下的残余浓度、视距受限）
       - 实时路况拥堵系数；高地应力/岩爆动态危险区（识别偏差≤5m）
  3. 矿岩散体堆积状态（作业对象）
       - 爆堆堆积形态与块度分布（10cm 以上块度识别率≥90%，大块率）
       - 装载点实时存量、取货点随机偏移
  4. 装备性能与能耗（经济性指标，对应“运营成本降低10%”）
       - 载重-能耗映射（空载去程 / 重载返程差异化能耗）
       - 装备健康状态（磨损→故障率、最大速度、安全刹车距离）

所有随机过程均基于固定随机种子（deterministic），同一场景可复现；
并通过 FluentRandom 封装为工程可解释的随机游走，非平均打散凑数。
"""
import json
import math
import random
import time
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any, Optional

from app.services.scheduling.scenario_config import load_scenario
from app.services.scheduling.muck_data import load_muck_tasks
from app.services.scheduling.multi_objective import solve_pareto

logger = logging.getLogger(__name__)

# =====================================================================
# 一、工程常数与装备库（依据井下铲运机/巷道通用规格拟合）
# =====================================================================

# 安全间距（m）：巷道侧向/顶部需预留的净空，来源：《金属非金属矿山安全规程》对
# 无轨运输巷道的行人避让与设备间隙要求。
SIDE_CLEARANCE = 0.40      # 单侧侧向安全间距
HEIGHT_CLEARANCE = 0.30    # 顶部安全间距
GAP_CLEARANCE = 0.25       # 会车/错车补充侧向间距（狭窄巷道单行道时启用门槛）

# 定位误差指标（项目要求）：
POS_ERROR_WORK_M = 0.30    # 作业点位定位误差 < 0.3m
POS_ERROR_TRAVEL_M = 0.80  # 行进定位误差 < 0.8m

# 大块识别指标（项目要求）：10cm 以上块度识别率 ≥ 90%
BLOCK_RECOGNITION_THRESHOLD_CM = 10.0
BLOCK_RECOGNITION_RATE_REQ = 0.90

# 运营成本降低目标（项目要求）
OPEX_REDUCTION_TARGET = 10.0  # %

# 岩爆危险区识别偏差目标（课题四要求）：≤5m
HAZARD_ZONE_BIAS_M = 5.0

# 能耗单价（成本口径，用于 OPEX 核算）
ENERGY_PRICE_KWH_RMB = 0.35      # 工业电价(元/kWh)
ENERGY_PRICE_L_RMB = 1.9         # 柴油价格(元/L)
# 路况用能修正系数（工程量级）：拥堵→启停/怠速附加能耗，岩爆→避险/重排附加能耗
CONGESTION_ENERGY_K = 0.9        # 拥堵系数每 1.0 增 ~90% 瞬时段比耗
ROCKBURST_ENERGY_K = 0.6         # 岩爆威胁每 1.0 增 ~60% 避险比耗
# NSGA-III 选解有效期：超时后视为过时（动态状态已演进），不再消费
PENDING_EXPIRE_S = 300.0         # 秒（≈60 仿真步）

# 多目标优化（NSGA-III/精确穷举）预计算缓存参数：
#   - 候选内容变化后，距离上次重算至少间隔 OPT_MIN_INTERVAL_S 才重算（过滤高频重算）；
#   - 即使候选 key 未变，每 OPT_REFRESH_S 也兜底刷新一次（捡拾舍入未覆盖的动态漂移）。
# 开关：设为 0 可关闭缓存（每帧快照都重算，仅用于调试）。
OPT_MIN_INTERVAL_S = 10.0
OPT_REFRESH_S = 60.0


# 装备库：铲运机(LHD) 通用规格（外形尺寸/斗容/铰接转弯半径实测量级）
# 说明：ST 系列为井下铰接式铲运机通行携带概约值，转弯半径取外转弯半径。
@dataclass
class LhdSpec:
    model: str
    width_m: float       # 外形宽
    height_m: float      # 外形高
    capacity_t: float    # 额定载重(t)
    bucket_m3: float     # 斗容(m³)
    turn_radius_m: float # 铰接外转弯半径(m)
    max_grade_empty_pct: float  # 空载最大爬坡(%)
    max_grade_loaded_pct: float # 重载最大爬坡(%)
    rated_speed_empty: float      # 空载平均行驶速度(km/h)
    rated_speed_loaded: float     # 重载平均行驶速度(km/h)
    empty_energy: float  # 空载能耗(kWh/km)  <- 电动LHD 垂巷能耗基准
    loaded_energy_k: float  # 重载比空载的能耗增益系数（含载重，kWh/t·km）
    energy_type: str     # 'electric' | 'diesel'
    diesel_l_per_km: float  # 柴油模式基础油耗(L/km)


# 设备库（LHD 规格）不再写死于此：由 config/scenario_<名>.json 的 "equipment" 字段驱动，
# 在 SchedulingSimulator.__init__ 中按场景配置构造（见 self.lhd）。


# 二、巷道网络（超深井高应力矿山典型采区出矿巷道）
# =====================================================================
# 巷道拓扑（节点 / 巷道段物理参数 / 开采水平分层 / 初始封锁 / 装载点 / 品位 / 设备库）
# 一律由 config/scenario_<名>.json 驱动（见 scenario_config.load_scenario / build_scenario），
# SchedulingSimulator 构造时按场景配置建立 self.tunnel_nodes / self.segments /
# self.levels_meta / self.level_segs / self.level_seg_sets / self.level_depth_m /
# self.initial_blocks / self.muck_metadata / self.grade_pct / self.muck_level /
# self.node_dump / self.lhd。新增巷道只需编辑场景 JSON，无需改本文件。
#
# 工程口径（作为新场景参数取值参考）：
#   - 主运输巷（大断面）：净宽 4.8m、净高 4.0m，坡度 ≤10%，最小转弯半径 ≥12m
#   - 中段斜坡道（缓坡）：净宽 4.4m、净高 3.8m，坡度 ≤12%
#   - 采场出矿道/装矿横巷（狭窄）：净宽 4.2m、净高 3.6m，坡度 ≤13%，急弯半径 6~9m
#   - 局部修复/高应力段：净宽 4.0m、净高 3.4m，坡度 ≤14%，且岩爆倾向性高
#
# 主井/斜井竖向段用能、速度模型（工程参数）
SHAFT_RISE_KMH = 8.0      # 竖井提升/下放等效速度(km/h)
SHAFT_ENERGY_KWH_PER_100M = 4.5   # 竖井每100m升降能耗(kWh/次，空载/重载基准)
SHAFT_RAMPUP = 1.0        # 斜井/联络巷竖向用能系数(相对立井)
BLOCK_HOLD_S = 150.0      # 封锁最短维持时长(s)：门窗滞回，避免封锁瞬时闪现
BLOCK_CLEAR_RB = 0.40     # 岩爆降至该值以下且持续足够长才解除封锁
BLOCK_CLEAR_SMOKE = 0.40  # 炮烟降至该值以下且持续足够长才解除封锁
RBUNLOCK_THREAT = 0.90    # 岩爆威胁>该值触发封锁
# 跨水平路径剪枝（工程规模控制）：单趟路径段数上限 / 每目标枚举路径数上限 / 每目标保留候选数
# 分层图+竖向穿梭使简单路径指数膨胀，需裁剪到调度可规模化计算的规模
ROUTE_MAX_HOPS = 9          # 单趟最多段数(含竖向升降)，过深路径工程上亦不采纳
ROUTE_DFS_PATH_CAP = 60     # 单目标 DFS 枚举路径数上限
ROUTE_CAP_PER_TARGET = 6    # 每目标最终保留的候选数（按能耗+时间综合排序，兼顾多样 Pareto）


def _default_size_hist(mm):
    """无数据库直方图时的块度分布兜底（依据 x50 粗/细工程经验拟合）。"""
    x50 = float(mm.get("frag_x50_m") or 0)
    coarse = x50 > 0.28
    if coarse:
        return [{"range": "0-10cm", "pct": 30.0}, {"range": "10-30cm", "pct": 30.0},
                {"range": "30-60cm", "pct": 22.0}, {"range": "60-100cm", "pct": 12.0},
                {"range": ">100cm", "pct": 6.0}]
    return [{"range": "0-10cm", "pct": 38.0}, {"range": "10-30cm", "pct": 34.0},
            {"range": "30-60cm", "pct": 18.0}, {"range": "60-100cm", "pct": 7.0},
            {"range": ">100cm", "pct": 3.0}]


# =====================================================================
# 三、随机过程封装：工程可解释的受限随机游走（非均匀打散凑数）
# =====================================================================
class FluentRandom:
    """给定时段内受控漂移的随机扰动。

    用 (base, drift, noise) 刻画：base 为期望基值，drift 为缓慢趋势，
    noise 为围绕基值的受限高斯扰动。整体 clamp 在 [lo, hi]。
    """
    __slots__ = ("base", "drift", "noise", "lo", "hi", "_val", "_sigma")

    def __init__(self, base, drift=0.0, noise=1.0, lo=0.0, hi=1.0, seed=None):
        self.base = base
        self.drift = drift
        self.noise = noise
        self.lo = lo
        self.hi = hi
        self._val = base
        self._sigma = max(base * 0.08, noise * 0.05)

    def step(self, rng, dt):
        target = max(self.lo, min(self.hi, self.base + self.drift * dt))
        # 指数逼近基值 + 受限扰动（Ornstein-Uhlenbeck 风格的均值回复）
        pull = 0.25 * (target - self._val)
        jump = rng.gauss(0, self._sigma)
        self._val = max(self.lo, min(self.hi, self._val + pull * dt + jump * math.sqrt(dt)))
        return self._val


# =====================================================================
# 四、数据结构
# =====================================================================
@dataclass
class EquipmentState:
    id: str
    name: str
    spec: str
    capacity_t: float
    bucket_m3: float
    energy_type: str
    # 位置：所在巷道段 + 段内进度(0~1) + 位置类型(空载去程/装载/重载返程)
    seg_id: str
    seg_progress: float
    node: str
    state: str                 # idle | loading | hauling | dumping
    payload_t: float           # 当前载重
    load_mode: str             # empty | loaded
    speed_kmh: float
    # 动态感知/环境
    pos_error_m: float
    pos_conf: float            # 定位置信度 0~1
    congestion_in: float       # 所在段实时拥堵系数
    smoke_ppm: float           # 所在段炮烟浓度(归一化0~1)
    # 装备健康/能耗
    health: float              # 健康指数 0~1
    health_factor: float       # 由健康导出的通行能力因子(0~1)
    energy_used_kwh: float     # 本班已耗电(kWh) 或等效柴油(L)
    energy_mapped_t: float     # 本班加权能耗成本(等效柴油L/或成本元)
    fault_rate: float          # 当前等效故障率(%/h)
    travel_cycles: int
    assigned: dict = field(default_factory=dict)   # 当前派单
    # 路径执行状态：按节点序列逐段穿越（跨开采水平）
    level: int = 0                                 # 当前所在开采水平(0主运~4底部)
    route_nodes: list = field(default_factory=list)  # 规划路径的节点序列(含起终点)
    route_levels: list = field(default_factory=list) # 与 route_nodes 一一对应的水平
    route_i: int = 0                                # 当前所在节点在 route_nodes 中的下标
    # 竖向段中间进度（跨水平穿梭时使用）
    vertical_seg: str = ""                          # 当前竖向段标识("S0"主井 / 节点id斜井)
    vertical_progress: float = 0.0
    # 本趟路径经济性核算：实际走法能耗 / 粗放基准(最近距离盲派)能耗
    route_energy_total: float = 0.0   # 本趟优化路径总能耗(与实际逐段累加同口径)
    ref_route_total: float = 0.0      # 本趟"最近距离盲派"基准路线的总能耗
    ref_energy_t: float = 0.0         # 本班粗放基准加权成本(元)；实际成本见 energy_mapped_t
    timestamp: float = 0.0


@dataclass
class MuckPileState:
    id: str
    zone: str
    gantry: str
    blastCycle: str
    shape: str
    spreadR_m: float
    heightM_m: float
    stock_t: float            # 实时存量 = 剩余工作量(t)
    initial_t: float
    inventory_pct: float
    pickupOffset_m: float     # 取货点随机偏移(m)（<= 爆堆散布半径）
    recognize_rate: float     # 10cm以上块度识别率(≥90%)
    bigBlockRatio: float      # 大块率(%)
    sizeHist: list            # 块度分布直方图
    muckingEffort_min: float  # 铲装耗时增量(min/t)
    gradePct: float = 0.8     # 矿石品位(% Cu)，纳入多目标调度（矿品要素）
    source: str = "simulated" # 数据来源: simulated | manual | scenario | blasting
    required_work_t: float = 0.0  # 需采矿工作量(t)（采矿区任务）
    frag_x50_m: float = 0.0       # 块度特征（可由爆破板块反哺）
    frag_x80_m: float = 0.0
    frag_xmax_m: float = 0.0
    frag_b: float = 2.0
    frag_n: float = 1.2


@dataclass
class SegmentDynState:
    id: str
    name: str
    smoke: float              # 炮烟浓度(归一化0~1)
    congestion: float         # 拥堵系数 0~1
    rockburst: float          # 当前岩爆威胁(0~1)
    blocked: bool             # 是否临时封闭（如岩爆预警/炮烟过高）
    blockReason: str
    blockT: float = 0.0       # 已封锁持续时长(s)：用于滞回解除


class SchedulingSimulator:
    def __init__(self, scenario=None, seed=20260822, dt=5.0):
        """构建现场调度仿真器。

        scenario: 由 scenario_config.build_scenario(load_config(name)) 产出的规范化场景 dict；
                  缺省时按默认场景（config/scenario_ashale.json）加载。
        巷道拓扑 / 开采分层 / 装载点 / 品位 / 设备库等全部"可替换内容"均来自场景配置。
        """
        self.cfg = scenario if scenario is not None else load_scenario()
        self.seed = seed
        self.rng = random.Random(seed)
        self.dt = dt  # 仿真相步(秒)
        self.t = 0.0

        # ---- 场景配置（见 config/scenario_<名>.json）----
        self.scenario_id = self.cfg.get("scenario", "underground-LHD")
        self.engine_name = self.cfg.get("engine", "井下LHD巷道调度仿真")
        self.node_dump = self.cfg.get("nodeDump", "S0")
        self.tunnel_nodes = self.cfg.get("tunnelNodes", [])
        self.segments = self.cfg.get("segments", [])   # 11 元组：见 scenario_config.parse_segments
        self.levels_meta = self.cfg.get("levelsMeta", [])
        self.level_segs = self.cfg.get("levelSegs", {})
        self.level_seg_sets = {lv: set(ids) for lv, ids in self.level_segs.items()}
        self.level_depth_m = self.cfg.get("levelDepthM", [0])
        self.initial_blocks = self.cfg.get("initialBlocks", [])
        self.grade_pct = self.cfg.get("gradePct", {})
        self.muck_level = self.cfg.get("muckLevel", {})
        self.lhd = {eid: LhdSpec(**e) for eid, e in self.cfg.get("equipment", {}).items()}
        # 采矿区任务（需采矿工作量 + 块度等）：数据库 scheduling_muck_task 优先，
        # 跨板块（爆破 blasting_result）反哺块度；无库时场景配置兜底（见 muck_data）。
        self.muck_tasks = load_muck_tasks(self.cfg)
        self.muck_metadata = self.muck_tasks
        self.run_id = f"{self.scenario_id}-{int(time.time())}"

        # ---- 设备（初始位置取场景内可用的巷道段）----
        self.equip = []
        init_segs = [s[0] for s in self.segments]
        for i, (eid, spec) in enumerate(sorted(self.lhd.items())):
            seg_idx = i % len(init_segs) if init_segs else 0
            self.equip.append(EquipmentState(
                id=eid, name=eid, spec=spec.model, capacity_t=spec.capacity_t,
                bucket_m3=spec.bucket_m3, energy_type=spec.energy_type,
                seg_id=init_segs[seg_idx] if init_segs else "",
                seg_progress=0.2 + 0.1 * i,
                node=self.node_dump if i == 0 else (self.segments[seg_idx][2] if self.segments else self.node_dump),
                state="idle", payload_t=0.0, load_mode="empty", speed_kmh=0.0,
                pos_error_m=0.15, pos_conf=0.97, congestion_in=0.0, smoke_ppm=0.05,
                health=0.95 - 0.06 * i, health_factor=1.0, energy_used_kwh=0.0,
                energy_mapped_t=0.0, ref_energy_t=0.0, fault_rate=0.3, travel_cycles=0,
            ))

        # ---- 段动态 ----
        self.segs = {}
        init_b = {b["seg"]: b["reason"] for b in self.initial_blocks}
        for seg in self.segments:
            seg_id, a, b, ln, w, h, g, r, smoke_bad, rb, nm = seg
            base_smoke = 0.55 if smoke_bad else 0.12
            self.segs[seg_id] = SegmentDynState(
                id=seg_id, name=nm, smoke=base_smoke, congestion=0.05,
                rockburst=rb, blocked=seg_id in init_b,
                blockReason=init_b.get(seg_id, ""),
                blockT=BLOCK_HOLD_S if seg_id in init_b else 0.0,
            )

        # ---- 爆堆/装载点（采矿区任务）----
        self.muck = {}
        for mm in self.muck_metadata:
            mid = mm.get("task_id") or mm.get("id")
            if not mid:
                continue
            stock = self._init_stock(mid)
            self.muck[mid] = self._make_muck(mm, stock)

        # ---- 时段性动态驱动器 ----
        self.smokeW = self._make_smoke_drivers()

        # ---- 全流程 OPEX 核算（实际 vs 粗放基准，覆盖完整装卸运循环）----
        self.actual_total = 0.0
        self.ref_total = 0.0

        # ---- NSGA-III 多目标选解待派单（前端提交后，下次 _dispatch 消费）----
        # 结构：{equipId: {"target": str, "path": [segId...], "source": "nsga3"}}
        self.pending_assignments = {}

        # ---- 多目标优化预计算缓存（后端算好前沿，前端点击板块直接消费）----
        # 按候选内容 key 缓存，仅当候选实质变化（或超时兜底刷新）时重算，
        # 避免每帧快照都重复跑 NSGA-III/精确穷举。
        self._opt_key = None          # 候选内容 hash
        self._opt_cache = None        # {paretoFront, objectiveDefs, optStats, source}
        self._opt_ts = 0.0            # 上次计算时刻（过滤高频重算）

    # ---------- 初始化/装载工具 ----------
    def _init_stock(self, mid):
        # 采矿区任务：剩余工作量优先，缺省取需采矿工作量/320t
        for mm in self.muck_metadata:
            if mm.get("task_id") == mid or mm.get("id") == mid:
                if mm.get("remaining_work_t") is not None:
                    return float(mm["remaining_work_t"])
                if mm.get("required_work_t") is not None:
                    return float(mm["required_work_t"])
                return float(mm.get("initialStockT", 320))
        return 320.0

    def _make_muck(self, mm, stock):
        """按采矿区任务数据构建爆堆/装载点状态。
        块度特征/直方图/大块率/识别率可由爆破板块反哺（source='blasting'）或人工编辑。"""
        rng = self.rng
        task_id = mm.get("task_id") or mm.get("id")
        hist = mm.get("size_hist") or _default_size_hist(mm)
        big_block = float(mm.get("big_block_ratio", 3.0))
        recognize = max(float(mm.get("recognize_rate", 0.95)), BLOCK_RECOGNITION_RATE_REQ)
        required = float(mm.get("required_work_t", stock or 320.0))
        # 铲装耗时增量(t/min)，大块率越高耗时越大（工程拟合：每t约2~6min）
        effort = 2.5 + big_block * 0.35 + (0.95 - recognize) * 20.0
        return MuckPileState(
            id=task_id, zone=mm.get("zone", ""), gantry=mm.get("gantry", ""),
            blastCycle=mm.get("blast_cycle", ""), shape=mm.get("shape", "半锥体散堆"),
            spreadR_m=float(mm.get("spread_r_m", 8.0)), heightM_m=float(mm.get("height_m_m", 2.0)),
            stock_t=stock, initial_t=required, inventory_pct=round(stock / required * 100, 1) if required > 0 else 0.0,
            pickupOffset_m=round(rng.uniform(0.8, min(float(mm.get("spread_r_m", 8.0)) * 0.5, 6.0)), 2),
            recognize_rate=round(recognize, 2), bigBlockRatio=round(big_block, 2), sizeHist=hist,
            muckingEffort_min=round(effort, 2),
            gradePct=float(mm.get("grade_pct", 0.8)),
            source=mm.get("source", "simulated"),
            required_work_t=required,
            frag_x50_m=float(mm.get("frag_x50_m", 0.0) or 0.0),
            frag_x80_m=float(mm.get("frag_x80_m", 0.0) or 0.0),
            frag_xmax_m=float(mm.get("frag_xmax_m", 0.0) or 0.0),
            frag_b=float(mm.get("frag_b", 2.0) or 2.0),
            frag_n=float(mm.get("frag_n", 1.2) or 1.2),
        )

    def _make_smoke_drivers(self):
        # 每个高炮烟段一个均值回复驱动器，爆破后浓度衰减
        drivers = {}
        for seg in self.segments:
            seg_id, a, b, ln, w, h, g, r, smoke_bad, rb, nm = seg
            if smoke_bad:
                drivers[seg_id] = FluentRandom(base=0.6, drift=-0.001, noise=0.5,
                                               lo=0.05, hi=0.95, seed=self.seed + hash(seg_id) % 97)
        return drivers

    def _segment(self, seg_id):
        # 由 id 找到段常量
        for seg in self.segments:
            if seg[0] == seg_id:
                return seg
        return None

    def _segment_between(self, node_a, node_b):
        """返回连接 node_a 与 node_b 的巷道段(含id)，不存在则返回 None。"""
        for seg in self.segments:
            a, b = seg[1], seg[2]
            if (a == node_a and b == node_b) or (a == node_b and b == node_a):
                return seg
        return None

    # ---------- 硬约束判定 ----------
    def passability(self, equip: EquipmentState, seg_id: str, load_mode: str) -> dict:
        """巷道物理通过性（硬约束）判定：
        返回 {passable, reasons[(type, desc, violate|ok)], detail}
        """
        seg = self._segment(seg_id)
        spec = self.lhd[equip.id]
        _, _, _, length, clearW, clearH, maxGrade, minTurnR, _, _, name = seg

        availW = clearW - SIDE_CLEARANCE
        availH = clearH - HEIGHT_CLEARANCE
        grade_limit = spec.max_grade_loaded_pct if load_mode == "loaded" else spec.max_grade_empty_pct

        reasons = []
        # 1) 净宽/高度
        if spec.width_m <= availW:
            reasons.append(("净宽", f"净宽{clearW:.1f}m-安全间距{SIDE_CLEARANCE:.2f}m={availW:.2f}m ≥ 车宽{spec.width_m:.2f}m", True))
        else:
            reasons.append(("净宽", f"净宽{clearW:.1f}m可用{availW:.2f}m < 车宽{spec.width_m:.2f}m", False))
        if spec.height_m <= availH:
            reasons.append(("净高", f"净高{clearH:.1f}m-顶部间距{HEIGHT_CLEARANCE:.2f}m={availH:.2f}m ≥ 车高{spec.height_m:.2f}m", True))
        else:
            reasons.append(("净高", f"净高{clearH:.1f}m可用{availH:.2f}m < 车高{spec.height_m:.2f}m", False))
        # 2) 坡度（按空/重载不同极限）
        if maxGrade <= grade_limit:
            reasons.append(("坡度", f"段坡度{maxGrade:.1f}% ≤ {load_mode}极限{grade_limit:.1f}%", True))
        else:
            reasons.append(("坡度", f"段坡度{maxGrade:.1f}% > {load_mode}极限{grade_limit:.1f}%", False))
        # 3) 最小转弯半径
        if minTurnR >= spec.turn_radius_m:
            reasons.append(("转弯半径", f"段最小转弯半径{minTurnR:.0f}m ≥ 车外转弯半径{spec.turn_radius_m:.1f}m", True))
        else:
            reasons.append(("转弯半径", f"段最小转弯半径{minTurnR:.0f}m < 车外转弯半径{spec.turn_radius_m:.1f}m", False))

        passable = all(r[2] for r in reasons)
        return {
            "segment": seg_id,
            "segmentName": name,
            "lengthM": length,
            "clearWidthM": clearW,
            "clearHeightM": clearH,
            "maxGradePct": maxGrade,
            "minTurnRadiusM": minTurnR,
            "loadMode": load_mode,
            "passable": passable,
            "reasons": reasons,
        }

    # ---------- 动态环境更新 ----------
    def _update_dynamic(self):
        """推进一帧动态环境：炮烟衰减/脉冲、拥堵慢变、岩爆扰动、定位误差漂移。"""
        rng = self.rng
        for seg_id, sd in self.segs.items():
            blk = self._segment(seg_id)
            smoke_bad = blk[8]
            if smoke_bad and seg_id in self.smokeW:
                # 炮烟：爆破后整体衰减，带低频扰动
                v = self.smokeW[seg_id].step(rng, self.dt)
            else:
                v = max(0.02, sd.smoke - 0.002 * self.dt + rng.gauss(0, 0.004))
            sd.smoke = round(max(0.01, min(1.0, v)), 3)
            # 拥堵：慢随机游走
            sd.congestion = round(max(0.0, min(1.0, sd.congestion + rng.uniform(-0.02, 0.03))), 3)
            if sd.congestion > 0.8 and not sd.blocked:
                sd.congestion = 0.78
            # 岩爆：倾向性高则偶发脉冲升高（高地应力段周期性加强，触发真实封锁-绕行）
            if blk[9] > 0.6:
                pulse = rng.random()
                threat = 0.35 + rng.uniform(0, 0.35)
                if pulse < 0.12:
                    threat = 0.97
                sd.rockburst = round(max(sd.rockburst, threat), 3)
            else:
                sd.rockburst = round(max(0.05, sd.rockburst - 0.01 * self.dt), 3)
            # 临时封闭：岩爆威胁>阈值 或 炮烟>0.85 时立即封锁该段（需动态绕行）；
            # 一旦封锁，需危险显著消退(低于解除阈值)且至少维持 BLOCK_HOLD_S 才解除，
            # 避免瞬时闪现、保证界面上封锁状态真实可见。
            if sd.rockburst > RBUNLOCK_THREAT or sd.smoke > 0.85:
                if not sd.blocked:
                    sd.blocked = True
                    sd.blockReason = "岩爆预警" if sd.rockburst > RBUNLOCK_THREAT else "炮烟浓度超限"
            if sd.blocked:
                sd.blockT += self.dt
                if sd.rockburst < BLOCK_CLEAR_RB and sd.smoke < BLOCK_CLEAR_SMOKE \
                        and sd.blockT >= BLOCK_HOLD_S:
                    sd.blocked = False
                    sd.blockReason = ""
                    sd.blockT = 0.0
            else:
                sd.blockT = 0.0

        # 定位误差/置信度：作业段严格 <0.3m，行进段 <0.8m
        for eq in self.equip:
            sd = self.segs.get(eq.seg_id)
            smoke_here = sd.smoke if sd else 0.0
            if eq.state == "loading":
                base_err = 0.16 + smoke_here * 0.10  # 作业点受炮烟影响
                base_err = min(POS_ERROR_WORK_M, base_err)  # 需求 <0.3m
                eq.pos_error_m = round(base_err, 3)
                eq.pos_conf = round(1.0 - (eq.pos_error_m / POS_ERROR_WORK_M) * 0.4, 3)
            else:
                base_err = 0.35 + smoke_here * 0.35
                base_err = min(POS_ERROR_TRAVEL_M, base_err)  # 需求 <0.8m
                eq.pos_error_m = round(base_err, 3)
                eq.pos_conf = round(1.0 - (eq.pos_error_m / POS_ERROR_TRAVEL_M) * 0.3, 3)

    # ---------- 爆堆/装载点更新 ----------
    def _update_muck(self):
        """装载点更新。
        # 存量只在装载到位时一次性扣减（见 _move_equipment / loading 分支），避免与
        此处重复扣减；本方法仅做取货点偏移的受控抖动与状态刷新。
        """
        rng = self.rng
        for mp in self.muck.values():
            # 取货点：随机堆积偏移小幅游走（有界均值回复）
            mp.pickupOffset_m = round(
                max(0.6, min(mp.spreadR_m * 0.5, mp.pickupOffset_m * 0.9 + rng.uniform(-0.3, 0.3))), 2
            )
            mp.inventory_pct = round(mp.stock_t / mp.initial_t * 100.0, 1) if mp.initial_t > 0 else 0.0

    # ---------- 装备推进与调度 ----------
    def _move_equipment(self):
        """推进装备状态机（空载去程→装载→重载返程→卸载），并推选一条可行路径。

        路径选择采用“硬约束过滤 + 动态代价”的贪心：
          - 对从起点到终点的候选路径集合（预置若干通道组合），先按巷道物理通过性硬过滤，
            仅保留当前装备（空/重载）可通过的路径；
          - 再按 能耗(空重分区) + 时间(受炮烟/拥堵/健康折减) + 危险暴露 加权选择。
        """
        rng = self.rng
        for eq in self.equip:
            spec = self.lhd[eq.id]

            # 1) 速度推演（受健康、炮烟、拥堵、定位置信度折减）
            health_factor = 0.75 + 0.25 * eq.health
            sd = self.segs.get(eq.seg_id)
            smoke_here = sd.smoke if sd else 0.0
            cong_here = sd.congestion if sd else 0.0
            smoke_factor = max(0.35, 1 - smoke_here * 1.3)          # 视距受限强制降速
            cong_factor = max(0.4, 1 - cong_here * 0.9)             # 拥堵降速
            pos_factor = eq.pos_conf                                 # 定位退化降速
            base_speed = spec.rated_speed_loaded if eq.load_mode == "loaded" else spec.rated_speed_empty
            speed = base_speed * health_factor * smoke_factor * cong_factor * pos_factor
            eq.health_factor = round(health_factor, 3)

            # 2) 状态机推进
            if eq.state == "idle":
                # 派单：若已指派目标则进入去程
                if eq.assigned:
                    eq.state = "hauling"
                    eq.speed_kmh = speed
                else:
                    eq.speed_kmh = 0

            elif eq.state == "loading":
                # 模拟铲装耗时（受大块率/识别率/取货偏移/存量影响）
                mp = self.muck.get(eq.node)
                if mp and mp.stock_t > 0:
                    pickup_penalty = 1.0 if mp.pickupOffset_m <= 1.5 else (2.0 + mp.pickupOffset_m * 0.3)
                    pile_penalty = 1 + mp.bigBlockRatio * 0.12
                    if rng.random() < (pickup_penalty * pile_penalty * self.dt / 60.0):
                        loaded = min(spec.capacity_t, mp.stock_t)
                        eq.payload_t = loaded
                        eq.load_mode = "loaded"
                        mp.stock_t = max(0.0, mp.stock_t - loaded)
                        mp.inventory_pct = round(mp.stock_t / mp.initial_t * 100, 1)
                        # 装载完成，规划重载返程（到卸载点）
                        self._begin_haul(eq, self.node_dump)
                        eq.state = "hauling"
                        eq.speed_kmh = speed
                else:
                    eq.state = "idle"
                    eq.assigned = {}

            elif eq.state == "hauling":
                # 沿当前段推进（多段路径逐段穿越，见 route_nodes/route_i）
                progress_kmh = speed * self.dt / 3600.0
                seg = self._segment(eq.seg_id)
                if seg is None:
                    # 竖向升/降段不在此水平状态机推进：直接切到下一水平段
                    eq.route_i += 1
                    if eq.route_i + 1 < len(eq.route_nodes):
                        eq.node = eq.route_nodes[eq.route_i]
                        nxt = self._segment_between(eq.node, eq.route_nodes[eq.route_i + 1])
                        eq.seg_id = nxt[0] if nxt else ""
                        nxtseg = self._segment(eq.seg_id)
                        if nxtseg is None:
                            eq.state = "idle"
                            eq.assigned = {}
                    else:
                        eq.state = "idle"
                        eq.assigned = {}
                    eq.speed_kmh = speed
                    continue
                seg_len_km = seg[3] / 1000.0
                eq.seg_progress += progress_kmh / seg_len_km
                # 能耗累积（空/重分区 + 路况用能）
                self._accumulate_energy(eq, progress_kmh)
                if eq.seg_progress >= 1.0:
                    eq.seg_progress = 0.0
                    eq.route_i += 1
                    if eq.route_i < len(eq.route_nodes):
                        eq.node = eq.route_nodes[eq.route_i]
                    if eq.route_i + 1 < len(eq.route_nodes):
                        # 尚有后续路段：切到下一段继续穿越
                        nxt = self._segment_between(eq.node, eq.route_nodes[eq.route_i + 1])
                        if nxt is not None:
                            eq.seg_id = nxt[0]
                        else:
                            eq.state = "idle"
                            eq.assigned = {}
                    else:
                        # 到达最终目的地：装载点(空载) 或 卸载点(重载)
                        arrived = eq.node
                        if eq.load_mode == "empty" and arrived in self.muck:
                            eq.state = "loading"
                        elif eq.load_mode == "loaded" and arrived == self.node_dump:
                            eq.state = "dumping"
                        else:
                            eq.state = "idle"
                            eq.assigned = {}
                eq.speed_kmh = speed

            elif eq.state == "dumping":
                if rng.random() < self.dt / 8.0:
                    eq.payload_t = 0.0
                    eq.load_mode = "empty"
                    eq.travel_cycles += 1
                    eq.state = "idle"
                    eq.assigned = {}

            # 3) 健康/故障率更新：磨损降低健康、提高故障率
            degrade = 0.0001 * self.dt + (0.05 if eq.energy_type == "diesel" else 0.0) * self.dt / 3600
            eq.health = round(max(0.4, eq.health - degrade), 4)
            eq.fault_rate = round(max(0.1, 0.25 + (1 - eq.health) * 8.0), 2)

        # 4) 为新闲置装备派单（多装备协同）
        self._dispatch()

    def _accumulate_energy(self, eq, dist_km):
        """逐帧累加本段实际能耗成本，并按“本趟优化路径 vs 最近距离盲派基准”比例
        分摊粗放基准成本（ref = 实际 × 基准总能耗 / 优化总能耗）。该口径由真实
        路径几何与路况驱动，非固定系数凑数。"""
        spec = self.lhd[eq.id]
        seg = self._segment(eq.seg_id)
        if seg is None:
            return  # 竖向段不在此水平能耗模型内（_vertical_cost 已计）
        sd = self.segs[eq.seg_id]
        # 空/重分区比耗
        if spec.energy_type == "electric":
            base = spec.empty_energy
            if eq.load_mode == "loaded":
                base += spec.loaded_energy_k * eq.payload_t
        else:
            base = spec.diesel_l_per_km
            if eq.load_mode == "loaded":
                base *= 1.6
        # 坡度用能修正（与 _seg_energy 同口径）
        grade = max(0.0, seg[6] - 8.0) / 100.0 * 2.0
        # 路况用能：拥堵→启停/怠速，岩爆→避险/重排
        dynamic = (1.0 + sd.congestion * CONGESTION_ENERGY_K) * \
                  (1.0 + sd.rockburst * ROCKBURST_ENERGY_K)
        unit = base * (1.0 + grade) * dynamic
        eq.energy_used_kwh += unit * dist_km
        if spec.energy_type == "electric":
            cur_cost = unit * dist_km * ENERGY_PRICE_KWH_RMB
        else:
            cur_cost = unit * dist_km * ENERGY_PRICE_L_RMB
        eq.energy_mapped_t += cur_cost

        # 粗放基准：最近距离盲派基准路线能耗 / 本趟优化路线能耗 的比例分摊
        if eq.route_energy_total > 0 and eq.ref_route_total > 0:
            ref_cost = cur_cost * (eq.ref_route_total / eq.route_energy_total)
        else:
            ref_cost = cur_cost
        eq.ref_energy_t += ref_cost

    def _consume_pending(self, eq, target):
        """仅重载返程（target==出口节点）消费 NSGA-III 选出的"采矿点→出口"路线。
        空载去程（target==采矿点）不消费——去程走贪心兜底，选解保留到装载完成后返程时消费。"""
        pa = self.pending_assignments.get(eq.id)
        if not pa:
            return None
        if target != self.node_dump:
            return None
        mid = pa.get("target")
        if mid not in self.muck:
            return None
        path = pa.get("path") or []
        if not path:
            return None
        # 重验：所有段重载工况可通行且未封闭（动态状态会演进，选解须经当前状态校验）
        for seg_id in path:
            if seg_id not in self.segs:
                return None
            sd = self.segs[seg_id]
            if sd.blocked or not self.passability(eq, seg_id, "loaded")["passable"]:
                return None
        self.pending_assignments.pop(eq.id, None)  # 校验通过才消费
        nodes = pa.get("nodes") or []
        levels = pa.get("levels") or []
        if not nodes:
            nodes = [mid]
            for seg_id in path:
                nodes.append(self._other_node(seg_id, nodes[-1]))
        if not levels:
            levels = [self.muck_level.get(mid, 0)] + [0] * (len(nodes) - 1)
        return {
            "path": path,
            "hops": pa.get("hops") or [],
            "nodes": nodes,
            "levels": levels,
            "energyTotal": pa.get("energyTotal") or sum(self._seg_energy(eq, s, "loaded") for s in path),
            "timeMin": pa.get("timeMin") or sum(self._seg_time(eq, s, "loaded") for s in path),
            "hazard": pa.get("hazard") or sum(self.segs[s].rockburst for s in path),
            "congestionSeq": pa.get("congestionSeq") or [round(self.segs[s].congestion, 2) for s in path],
            "blocked": False,
            "reason": "NSGA-III 多目标选路（采矿点→出口）",
        }

    def _begin_haul(self, eq, target, route=None):
        """开始一段行程：初始化多段路径执行状态与本节经济性基准。
        target：空载→装载点；重载→卸载点 self.node_dump。
        NSGA-III 选解优先，其次贪心单目标兜底。
        返回 (bool) 是否成功出发。"""
        if route is None:
            route = self._consume_pending(eq, target)
        if route is None:
            route = self._plan_route(eq, target)
        if not route or not route["path"]:
            eq.state = "idle"
            eq.assigned = {}
            return False
        # 由路径还原节点序列与各节点所在开采水平（含竖向穿梭）
        if route.get("nodes") and route.get("levels"):
            nodes = route["nodes"]
            levels = route["levels"]
        else:  # 兼容纯平面候选
            nodes = [eq.node]
            for seg_id in route["path"]:
                nodes.append(self._other_node(seg_id, nodes[-1]))
            levels = [eq.level] * len(nodes)
        eq.route_nodes = nodes
        eq.route_levels = levels
        eq.route_i = 0
        eq.node = nodes[0]
        eq.level = levels[0]
        eq.vertical_progress = 0.0
        eq.vertical_seg = ""
        # 若路径首步为竖向，交给竖向推进；否则初始化为首条水平段
        first = self._hop_between(eq, 0)
        if first and first["kind"] == "h":
            eq.seg_id = first["seg"]
            eq.seg_progress = 0.0
        else:
            eq.seg_id = eq.vertical_seg or ""
            eq.seg_progress = 0.0
        eq.route_energy_total = route["energyTotal"]
        # 粗放基准：最近距离盲派（不规避路况/岩爆）的路径能耗
        ref_energy = self._shortest_route_energy(eq, target)
        eq.ref_route_total = ref_energy if ref_energy is not None else route["energyTotal"]
        eq.assigned = {
            "target": target,
            "targetMuck": target if eq.load_mode == "empty" else "",
            "goal": "装载点" if eq.load_mode == "empty" else "卸载点",
            "path": route["path"],
            "levels": levels,
            "energyTotal": round(route["energyTotal"], 2),
            "refEnergyTotal": round(eq.ref_route_total, 2),
            "timeMin": round(route["timeMin"], 1),
            "hazard": round(route["hazard"], 3),
            "reason": route["reason"],
            "congestionSeq": route["congestionSeq"],
        }
        return True

    def _hop_between(self, eq, i):
        """返回 顶点 i → i+1 的跳转信息（None 表示到达终点）。"""
        if i + 1 >= len(eq.route_nodes):
            return None
        cn, cl = eq.route_nodes[i], eq.route_levels[i]
        nn, nl = eq.route_nodes[i + 1], eq.route_levels[i + 1]
        if nn == cn and nl != cl:
            return {"kind": "v", "node": cn, "dl": (nl - cl)}
        seg = self._segment_between(cn, nn)
        if seg is not None:
            return {"kind": "h", "seg": seg[0]}
        return {"kind": "h", "seg": None}

    def _shortest_route_energy(self, eq, target):
        """粗放基准路线能耗：最近的物理可通行路径，即使其拥堵/岩爆严重也照走
        （“盲派”不规避路况）。返回该路径总能耗或 None。"""
        best_path, best_len = None, float("inf")

        def dfs(node, path, visited, total_len):
            nonlocal best_path, best_len
            if node == target:
                if total_len < best_len:
                    best_len = total_len
                    best_path = list(path)
                return
            for seg_id, nxt in self._adjacent(node):
                if nxt in visited:
                    continue
                seg = self._segment(seg_id)
                sd = self.segs[seg_id]
                if not self.passability(eq, seg_id, eq.load_mode)["passable"] or sd.blocked:
                    continue
                dfs(nxt, path + [seg_id], visited | {nxt}, total_len + seg[3])

        dfs(eq.node, [], {eq.node}, 0.0)
        if not best_path:
            return None
        return sum(self._seg_energy(eq, s) for s in best_path)

    def _dispatch(self):
        """对所有闲置装备分配装载点与路径（多装备协同，避免拥堵/死锁）。
        NSGA-III 多目标选解优先消费，其次贪心单目标兜底。"""
        # 清理超时的 NSGA-III 选解（动态状态已演进，不再适用）
        expired = [
            k for k, pa in self.pending_assignments.items()
            if pa.get("_t") is not None and self.t - pa["_t"] > PENDING_EXPIRE_S
        ]
        for k in expired:
            self.pending_assignments.pop(k, None)

        idle = [eq for eq in self.equip if eq.state == "idle"]
        if not idle:
            return
        # 优先消费前端 NSGA-III 提交的选解（pending_assignments，目标=采矿点）
        # 选解语义：设备空载去该采矿区装矿，重载沿选解路线运到出口（采矿点→出口）。
        # 空载去程走贪心，选解保留到装载完成返程时由 _consume_pending 消费。
        for eq in idle:
            pa = self.pending_assignments.get(eq.id)
            if not pa:
                continue
            target = pa.get("target")
            if target not in self.muck:
                continue
            mp = self.muck.get(target)
            if eq.node == target and mp and mp.stock_t > 0:
                # 已在采矿点：直接进入装载（选解保留，返程时消费）
                eq.assigned = {"target": eq.node, "targetMuck": eq.node,
                               "goal": "装载点", "path": []}
                eq.state = "loading"
                continue
            if mp and mp.stock_t > 0:
                self._begin_haul(eq, target)  # 空载去程（贪心），选解保留
        # 剩余设备走贪心单目标兜底
        for eq in idle:
            if eq.assigned:
                continue  # 已被 NSGA-III 选解派单
            if eq.node in self.muck:
                # 已停在有存量的装载点，直接进入装载（无需绕行）
                mp = self.muck.get(eq.node)
                if mp and mp.stock_t > 0:
                    eq.assigned = {"target": eq.node, "targetMuck": eq.node,
                                   "goal": "装载点", "path": []}
                    eq.state = "loading"
                    continue
            # 候选装载点：有存量且可到达
            candidates = []
            for mid, mp in self.muck.items():
                if mp.stock_t <= 0:
                    continue
                route = self._plan_route(eq, mid)
                if not route or route["blocked"]:
                    continue
                # 动态代价：能耗 + 时间(受炮烟/拥堵) + 危险暴露 + 大块率惩罚 + 路径拥堵
                congest = max(route.get("congestionSeq") or [0]) if route.get("congestionSeq") else 0.0
                cost = route["energyTotal"] * 1.2 + route["timeMin"] * 0.6 + \
                       route["hazard"] * 8 + mp.bigBlockRatio * 0.6 + congest * 3
                candidates.append((cost, mid, route, mp))
            if not candidates:
                eq.assigned = {}
                continue
            candidates.sort(key=lambda x: x[0])
            _, mid, route, mp = candidates[0]
            self._begin_haul(eq, mid, route=route)

    # ---------- 路径规划（分层图：硬约束过滤 + 动态代价）----------
    def _node_on_level(self, node, level):
        """节点 node 是否在开采水平 level 上有相邻巷道。"""
        for seg in self.segments:
            if seg[0] not in self.level_seg_sets[level]:
                continue
            if seg[1] == node or seg[2] == node:
                return True
        return False

    def _adjacent_vertices(self, node, level, eq=None, tgt_lv=None, load_mode=None):
        """(node, level) 的全部相邻顶点；返回 [(hop, (nn,nl))]。
        同层走水平巷道段；跨层走斜井/联络巷（仅当该节点在相邻两层都布巷时，且只沿
        “趋向目标水平”的方向推进——杜绝同节点无意义上下穿梭产生的垃圾路径，让
        深部布网在真正服务于深部装载点时才会被路径算法用到）。
        """
        out = []
        lm = load_mode if load_mode is not None else (eq.load_mode if eq else None)
        for seg in self.segments:
            seg_id = seg[0]
            if seg_id not in self.level_seg_sets[level]:
                continue
            a, b = seg[1], seg[2]
            nxt = b if a == node else (a if b == node else None)
            if nxt is None:
                continue
            if lm is not None:
                sd = self.segs[seg_id]
                if sd.blocked or not self.passability(eq, seg_id, lm)["passable"]:
                    continue
            out.append(({"kind": "h", "seg": seg_id}, (nxt, level)))
        # 竖向段：仅朝目标水平单调推进；已到目标水平或目标未知则不提供竖向
        if tgt_lv is not None and level != tgt_lv:
            step = 1 if tgt_lv > level else -1
            nl = level + step
            if 0 <= nl < len(self.levels_meta) \
                    and self._node_on_level(node, level) and self._node_on_level(node, nl):
                out.append(({"kind": "v", "node": node, "dl": step}, (node, nl)))
        return out

    def _adjacent(self, node, level=0):
        """物理节点在给定开采水平上的全部相邻 (seg_id, next_node)。
        供“最近距离盲派”最短路基准使用（不规避路况/岩爆）。"""
        out = []
        for seg in self.segments:
            seg_id = seg[0]
            if seg_id not in self.level_seg_sets[level]:
                continue
            a, b = seg[1], seg[2]
            if a == node:
                out.append((seg_id, b))
            elif b == node:
                out.append((seg_id, a))
        return out

    def _other_node(self, seg_id, node):
        for seg in self.segments:
            if seg[0] == seg_id:
                return seg[2] if seg[1] == node else seg[1]
        return None

    def _vertical_leg_dist(self, lv_a, lv_b):
        return abs(self.level_depth_m[lv_a] - self.level_depth_m[lv_b])

    def _vertical_cost(self, eq, lv_a, lv_b):
        """竖向段(主井/斜井)升降的能耗/时间：按落差、空/重载系数。"""
        spec = self.lhd[eq.id]
        dm = self._vertical_leg_dist(lv_a, lv_b)
        load_k = 1.5 if eq.load_mode == "loaded" else 1.0
        energy = SHAFT_ENERGY_KWH_PER_100M * (dm / 100.0) * load_k * SHAFT_RAMPUP
        if spec.energy_type == "diesel":
            energy = energy / ENERGY_PRICE_KWH_RMB * ENERGY_PRICE_L_RMB
        time_min = (dm / 1000.0) / SHAFT_RISE_KMH * 60.0
        return energy, time_min

    def _enumerate_routes(self, eq: EquipmentState, target: str,
                          start_node=None, start_lv=None, load_mode=None, max_hops=None):
        """受限 DFS 枚举若干可行简单路径（分层图 + 硬约束/封锁剪枝）。
        跨水平穿梭使简单路径组合指数膨胀，故对长度与数量做工程剪枝：
        返回的仍是真实可行路径，但控制在调度可规模化计算的规模内。
        每 hop 为 {"kind":"h","seg":..}|{"kind":"v","node":..,"dl":..}。
        start_node/start_lv：可指定起点（如"采矿点→出口"候选从采矿区出发）；
        load_mode：可指定通过性/代价模式（如重载返程）；
        max_hops：单趟段数上限（深部采矿区跨水平需更多竖向段，可适当放宽）。"""
        sn = start_node if start_node is not None else eq.node
        sl = start_lv if start_lv is not None else eq.level
        start_v = (sn, sl)
        tgt_lv = self.muck_level.get(target or "", 0)
        target_v = (target, tgt_lv)
        if start_v[0] is None or target is None or start_v == target_v:
            return []
        paths = []

        # 剪枝上限：单趟路径段数 + 每目标保留路径数，防止跨层组合爆炸（实测可达十几万条）
        max_hops = max_hops or ROUTE_MAX_HOPS
        cap = ROUTE_DFS_PATH_CAP

        def dfs(v, hops, visited):
            if v[0] == target:
                # 到达目标节点即停止扩展（无论层位），仅在目标层位记录——
                # 避免深部路径在出口节点(S0)逐层"折返上下穿梭"填满枚举上限，
                # 导致真实单程路径反被挤掉（如深层采场的候选全部被环回过滤）。
                if v[1] == tgt_lv:
                    paths.append(list(hops))
                return
            # 到达深度上限或目标路径数达上限即不再扩展
            if len(hops) >= max_hops or len(paths) >= cap:
                return
            for hop, nv in self._adjacent_vertices(
                node=v[0], level=v[1], eq=eq, tgt_lv=tgt_lv, load_mode=load_mode
            ):
                if nv in visited:
                    continue
                dfs(nv, hops + [hop], visited | {nv})

        dfs(start_v, [], {start_v})
        return paths

    def _route_cost_vector(self, eq: EquipmentState, hops, load_mode=None, start_node=None, start_lv=None):
        """单条路径的多维代价向量（能耗/时间/危险/拥堵）。hops 含水平段与竖向段。
        load_mode 可显式指定（如候选按重载返程评估），缺省用设备当前状态。
        start_node/start_lv：可指定路径起点（如"采矿点→出口"候选从采矿区出发）。"""
        lm = load_mode or eq.load_mode
        energy = 0.0
        time_min = 0.0
        hazard = 0.0
        cong_seq = []
        blocked = False
        nodes = [start_node if start_node is not None else eq.node]
        levels = [start_lv if start_lv is not None else eq.level]
        cur_lv = levels[0]
        for hop in hops:
            if hop["kind"] == "h":
                seg_id = hop["seg"]
                sd = self.segs[seg_id]
                energy += self._seg_energy(eq, seg_id, lm)
                time_min += self._seg_time(eq, seg_id, lm)
                hazard += sd.rockburst * 1.0
                cong_seq.append(round(sd.congestion, 2))
                if sd.blocked or not self.passability(eq, seg_id, lm)["passable"]:
                    blocked = True
                nxt = self._other_node(seg_id, nodes[-1])
                nodes.append(nxt)
                levels.append(cur_lv)
            else:
                nl = cur_lv + hop["dl"]
                e, tm = self._vertical_cost(eq, cur_lv, nl)
                energy += e
                time_min += tm
                hazard += 0.05
                cong_seq.append(0.0)
                nodes.append(hop["node"])
                levels.append(nl)
                cur_lv = nl
        return {
            "path": [h["seg"] for h in hops if h["kind"] == "h"],
            "hops": hops,
            "nodes": nodes,
            "levels": levels,
            "energyTotal": energy,
            "timeMin": time_min,
            "hazard": hazard,
            "congestionSeq": cong_seq,
            "blocked": blocked,
        }

    def plan_route_candidates(self, eq: EquipmentState, target: str):
        """枚举全部可行候选路径，每条附多维代价向量 + 装载点要素（供 NSGA-III 多目标优化）。
        候选代价取快照时点值；实际执行时 _dispatch 会按最新动态状态重验。"""
        if not eq.node:
            return []
        mp = self.muck.get(target)
        cands = []
        for hops in self._enumerate_routes(eq, target):
            cv = self._route_cost_vector(eq, hops)
            if cv["blocked"]:
                continue
            horiz = [h for h in hops if h["kind"] == "h"]
            cands.append({
                **cv,
                "target": target,
                "targetLevel": self.muck_level.get(target, eq.level),
                "zone": mp.zone if mp else "",
                "gradePct": mp.gradePct if mp else 0.0,
                "bigBlockRatio": mp.bigBlockRatio if mp else 0.0,
                "muckingEffortMinPerT": mp.muckingEffort_min if mp else 0.0,
                "lengthM": round(sum(self._segment(h["seg"])[3] for h in horiz), 1),
            })
        if cands:
            cands.sort(key=lambda c: c["energyTotal"] + c["timeMin"])
            cands = cands[:ROUTE_CAP_PER_TARGET]
        return cands

    def plan_muck_exit_candidates(self, eq: EquipmentState):
        """枚举"采矿点→出口"重载返程候选路径（供 NSGA-III 多目标优化）。

        限制：每条候选的起点=采矿区(装载点)节点、终点=出口节点(self.node_dump, 井底车场/主井)。
        语义：设备空载去采矿点装矿，重载沿该路线将矿石搬运到出口卸载。
        候选代价按重载工况评估；同时携带采矿区任务要素（工作量/品位/大块率/铲装耗时）。
        """
        exit_node = self.node_dump
        exit_lv = self.muck_level.get(exit_node, 0)
        cands = []
        for mid, mp in self.muck.items():
            if mp.stock_t <= 0:
                continue
            task = next((t for t in self.muck_tasks if (t.get("task_id") or t.get("id")) == mid), None)
            mn = mid if mid in self.tunnel_nodes else (task.get("node") if task else None)
            ml = int(task.get("muck_level", self.muck_level.get(mid, 0))) if task else int(self.muck_level.get(mid, 0))
            if not mn:
                continue
            for hops in self._enumerate_routes(eq, exit_node, start_node=mn, start_lv=ml,
                                               load_mode="loaded", max_hops=ROUTE_MAX_HOPS + 9):
                cv = self._route_cost_vector(eq, hops, load_mode="loaded", start_node=mn, start_lv=ml)
                if cv["blocked"]:
                    continue
                # 过滤分层图中"途经出口又折返"的冗余环路（终点应恰好到出口一次）
                if cv["nodes"].count(exit_node) > 1:
                    continue
                horiz = [h for h in hops if h["kind"] == "h"]
                # 约束标记：起点=采矿点，终点=出口
                cv["startNode"] = mn
                cv["endNode"] = exit_node
                cands.append({
                    **cv,
                    "target": mid,
                    "targetLevel": ml,
                    "zone": mp.zone,
                    "gradePct": mp.gradePct,
                    "bigBlockRatio": mp.bigBlockRatio,
                    "muckingEffortMinPerT": mp.muckingEffort_min,
                    "requiredWorkT": round(mp.required_work_t, 1),
                    "remainingWorkT": round(mp.stock_t, 1),
                    "leg": "采矿点→出口",
                    "lengthM": round(sum(self._segment(h["seg"])[3] for h in horiz), 1),
                })
        if cands:
            cands.sort(key=lambda c: c["energyTotal"] + c["timeMin"])
            # 每个采矿区保留若干条（避免单点垄断候选空间）
            by_muck = {}
            for c in cands:
                by_muck.setdefault(c["target"], []).append(c)
            cands = [c for lst in by_muck.values() for c in lst[:ROUTE_CAP_PER_TARGET]]
        return cands

    def _plan_route(self, eq: EquipmentState, target_muck: str):
        """从 (eq.node,eq.level) 到 target_muck 所在水平的最优路径（硬约束 + 加权单目标兜底）。
        多目标选路由 NSGA-III 在前端完成，本方法保留单目标口径供回退与基准对比。"""
        if not eq.node or (eq.node == target_muck and eq.level == self.muck_level.get(target_muck, 0)):
            return None
        cands = self.plan_route_candidates(eq, target_muck)
        if not cands:
            return None
        best = None
        best_cost = float("inf")
        for c in cands:
            cost = c["energyTotal"] + c["timeMin"] * 1.0 + c["hazard"] * 2.0
            if cost < best_cost:
                best_cost = cost
                best = c
        if best is None:
            return None
        return {
            "path": best["path"],
            "hops": best["hops"],
            "nodes": best["nodes"],
            "levels": best["levels"],
            "energyTotal": best["energyTotal"],
            "timeMin": best["timeMin"],
            "hazard": best["hazard"],
            "congestionSeq": best["congestionSeq"],
            "blocked": False,
            "reason": "硬约束通过 + 动态代价最小",
        }

    def _seg_energy(self, eq, seg_id, load_mode=None):
        """单段能耗(与 _accumulate_energy 同口径)：空重分区 + 坡度 + 路况(拥堵/岩爆)。
        load_mode 可显式指定（如候选按重载返程评估），缺省用设备当前状态。"""
        lm = load_mode or eq.load_mode
        spec = self.lhd[eq.id]
        seg = self._segment(seg_id)
        sd = self.segs[seg_id]
        len_km = seg[3] / 1000.0
        grade = max(0.0, seg[6] - 8.0) / 100.0 * 2.0
        dynamic = (1.0 + sd.congestion * CONGESTION_ENERGY_K) * \
                  (1.0 + sd.rockburst * ROCKBURST_ENERGY_K)
        if spec.energy_type == "electric":
            base = spec.empty_energy + (spec.loaded_energy_k * eq.payload_t if lm == "loaded" else 0.0)
            return base * (1 + grade) * dynamic * len_km
        else:
            l = spec.diesel_l_per_km * (1.6 if lm == "loaded" else 1.0)
            return l * (1 + grade) * dynamic * len_km

    def _seg_time(self, eq, seg_id, load_mode=None):
        lm = load_mode or eq.load_mode
        spec = self.lhd[eq.id]
        seg = self._segment(seg_id)
        sd = self.segs[seg_id]
        len_km = seg[3] / 1000.0
        base = spec.rated_speed_loaded if lm == "loaded" else spec.rated_speed_empty
        base *= (0.75 + 0.25 * eq.health)
        base *= max(0.35, 1 - sd.smoke * 1.3)
        base *= max(0.4, 1 - sd.congestion * 0.9)
        return (len_km / max(base, 1.0)) * 60.0

    # ---------- 多目标优化预计算（后端） ----------
    def _opt_candidate_key(self, candidates_by_equip):
        """候选内容摘要 key：与前端"候选变化才重算"的判定同源（target/path/能耗/时间/品位），
        取值做受控舍入，吸收动态环境的微小漂移，避免每个快照周期都触发重算。"""
        parts = []
        for eq_id in sorted(candidates_by_equip.keys()):
            row = []
            for c in candidates_by_equip[eq_id]:
                row.append(
                    "{}|{}|{}|{}|{}|{}|{}"
                    .format(
                        c.get("target", ""),
                        ",".join(c.get("path") or []),
                        round(c.get("energyTotal") or 0.0, 1),
                        round(c.get("timeMin") or 0.0, 1),
                        round(c.get("hazard") or 0.0, 2),
                        round(c.get("gradePct") or 0.0, 2),
                        round(c.get("remainingWorkT") or 0.0, 1),
                    )
                )
            parts.append("=".join(row) if row else "^")
        return "#".join(parts)

    def _optimization_plan(self) -> dict:
        """构建多目标优化候选空间，并**预计算**帕累托前沿（pymoo NSGA-III）。

        预计算结果按候选内容 key 缓存（self._opt_key / self._opt_cache），仅当候选
        实质变化（且距上次重算 ≥ OPT_MIN_INTERVAL_S）或每 OPT_REFRESH_S 兜底刷新时
        才会再次运行算法；其余快照直接复用，前端打开板块零计算延迟。

        返回字典字段：
          - desc / byEquipment / stopes：候选空间与采区摘要（原逻辑不变）；
          - paretoFront：帕累托前沿（[{assignment, objectives, rank, crowdingDistance}]，
            assignment[i] = 设备 i 的候选索引，等于候选数表示"等待"）；
          - objectiveDefs：6 目标定义（id/name/dir/unit/desc/why）；
          - optStats：{engine: 'pymoo', paretoSize, combos, latencyMs, ...}。
        """
        # 1) 候选空间：仅空载设备提供"采矿点→出口"重载返程候选（原实现保持不变）
        candidates_by_equip = {}
        for eq in self.equip:
            if eq.load_mode == "empty":
                candidates_by_equip[eq.id] = self.plan_muck_exit_candidates(eq)
            else:
                candidates_by_equip[eq.id] = []

        optimization = {
            "desc": "多目标优化候选空间（NSGA-III 离散决策空间）· 后端预计算",
            "byEquipment": candidates_by_equip,
        }

        # 2) 采区摘要（全覆盖约束 / 品位下限 / 采场均衡目标 / 采场摘要卡片）
        zone_agg = {}
        for mp in self.muck.values():
            if mp.stock_t <= 0:
                continue
            z = mp.zone or "未知采区"
            agg = zone_agg.setdefault(z, {
                "zone": z, "muckIds": [], "remainingWorkT": 0.0,
                "gradeSum": 0.0, "gantry": mp.gantry, "count": 0,
            })
            agg["muckIds"].append(mp.id)
            agg["remainingWorkT"] += mp.stock_t
            agg["gradeSum"] += mp.gradePct
            agg["count"] += 1
        optimization["stopes"] = [
            {
                "zone": a["zone"], "muckIds": a["muckIds"],
                "gantry": a["gantry"], "count": a["count"],
                "remainingWorkT": round(a["remainingWorkT"], 1),
                "avgGradePct": round(a["gradeSum"] / a["count"], 3),
            }
            for a in zone_agg.values()
        ]

        # 3) 帕累托前沿预计算（缓存）：候选按设备顺序排列，供 solve_pareto 使用
        candidates_list = [candidates_by_equip[eq.id] for eq in self.equip]
        key = self._opt_candidate_key(candidates_by_equip)
        now = time.time()

        stale_key = key != self._opt_key
        timed_refresh = now - self._opt_ts >= OPT_REFRESH_S
        cooled_down = now - self._opt_ts >= OPT_MIN_INTERVAL_S
        if OPT_MIN_INTERVAL_S <= 0 or self._opt_cache is None or (stale_key and cooled_down) or timed_refresh:
            try:
                result = solve_pareto(candidates_list)
                stats = dict(result["stats"])
                stats["source"] = result["source"]
                stats["generatedAtSimSec"] = round(self.t, 1)
                stats["computedAt"] = datetime.now().isoformat()
                self._opt_cache = {
                    "paretoFront": result["paretoFront"],
                    "objectiveDefs": result["objectives"],
                    "optStats": stats,
                    "source": result["source"],
                }
                self._opt_key = key
                self._opt_ts = now
            except Exception:
                # 算法异常不允许阻断快照：回退到"无前沿"，前端走本地兜底并提示
                logger.exception("[Sched] 多目标优化预计算失败，快照不携带 paretoFront")
                self._opt_cache = {"paretoFront": [], "objectiveDefs": [],
                                   "optStats": {"source": "error"}, "source": "error"}
                self._opt_key = key
                self._opt_ts = now

        optimization["paretoFront"] = self._opt_cache.get("paretoFront", [])
        optimization["objectiveDefs"] = self._opt_cache.get("objectiveDefs", [])
        optimization["optStats"] = self._opt_cache.get("optStats", {})
        return optimization

    def snapshot(self, full=True) -> dict:
        """返回完整结构化状态快照（前端面板消费）。"""
        hard = []
        rep_eq = next(iter(self.equip))
        for seg in self.segments:
            seg_id, a, b, ln, w, h, g, r, smoke_bad, rb, nm = seg
            row = {
                "id": seg_id, "from": a, "to": b, "name": nm,
                "lengthM": ln, "clearWidthM": w, "clearHeightM": h,
                "maxGradePct": g, "minTurnRadiusM": r, "type": nm,
                "smokeBad": smoke_bad, "rockburstTend": rb,
            }
            # 用一台代表装备的通过性示例（重载工况，最严格）
            pa = self.passability(rep_eq, seg_id, "loaded")
            row["passableLoaded"] = pa["passable"]
            hard.append(row)

        dynamic = {
            "posErrorSpec": {"workM": POS_ERROR_WORK_M, "travelM": POS_ERROR_TRAVEL_M},
            "segments": [
                {
                    "id": sd.id, "name": sd.name, "smoke": sd.smoke, "congestion": sd.congestion,
                    "rockburst": sd.rockburst, "blocked": sd.blocked, "blockReason": sd.blockReason,
                    "hazardBiasM": HAZARD_ZONE_BIAS_M,
                }
                for sd in self.segs.values()
            ],
        }

        muck = [
            {
                "id": mp.id, "zone": mp.zone, "gantry": mp.gantry, "blastCycle": mp.blastCycle,
                "shape": mp.shape, "spreadR_m": mp.spreadR_m, "heightM_m": mp.heightM_m,
                "stock_t": round(mp.stock_t, 1), "initial_t": mp.initial_t,
                "requiredWorkT": round(mp.required_work_t, 1),
                "remainingWorkT": round(mp.stock_t, 1),
                "inventoryPct": mp.inventory_pct, "pickupOffsetM": mp.pickupOffset_m,
                "recognizeRate": mp.recognize_rate, "bigBlockRatio": mp.bigBlockRatio,
                "sizeHist": mp.sizeHist, "muckingEffortMin_perT": mp.muckingEffort_min,
                "gradePct": mp.gradePct, "source": mp.source,
                "fragX50M": mp.frag_x50_m, "fragX80M": mp.frag_x80_m,
                "fragXmaxM": mp.frag_xmax_m, "fragB": mp.frag_b, "fragN": mp.frag_n,
                "recognitionReq": BLOCK_RECOGNITION_RATE_REQ,
            }
            for mp in self.muck.values()
        ]

        equip = []
        for eq in self.equip:
            # 计算重载 vs 空载能耗差（体现空重分区经济性）
            spec = self.lhd[eq.id]
            energy_ratio = None
            if spec.energy_type == "electric" and spec.empty_energy > 0:
                energy_ratio = round((spec.empty_energy + spec.loaded_energy_k * spec.capacity_t)
                                     / spec.empty_energy, 2)
            # 竖向升降段中设备 seg_id 暂为空（不在某条水平巷道段上），路况取 0 兜底
            seg_state = self.segs.get(eq.seg_id)
            equip.append({
                "id": eq.id, "name": eq.id, "model": eq.spec, "energyType": spec.energy_type,
                "capacityT": spec.capacity_t, "bucketM3": spec.bucket_m3,
                "widthM": spec.width_m, "heightM": spec.height_m,
                "turnRadiusM": spec.turn_radius_m,
                "segId": eq.seg_id, "node": eq.node, "segProgress": round(eq.seg_progress, 3),
                "state": eq.state, "payloadT": round(eq.payload_t, 1), "loadMode": eq.load_mode,
                "speedKmh": round(eq.speed_kmh, 1),
                "posErrorM": eq.pos_error_m, "posConf": eq.pos_conf,
                "congestionIn": round(seg_state.congestion, 3) if seg_state else 0.0,
                "smokeIn": round(seg_state.smoke, 3) if seg_state else 0.0,
                "health": round(eq.health, 3), "healthFactor": eq.health_factor,
                "faultRatePerH": eq.fault_rate,
                "energyUsed": round(eq.energy_used_kwh, 1),
                "energyCostRMB": round(eq.energy_mapped_t, 1),
                "energyEmptyLoadedRatio": energy_ratio,
                "travelCycles": eq.travel_cycles,
                "assigned": eq.assigned,
            })

        # OPEX 同比节省估算：实际加权能耗成本 vs 粗放基准(最近距离盲派不走路况规避)
        actual_total = sum(eq.energy_mapped_t for eq in self.equip)
        ref_total = sum(eq.ref_energy_t for eq in self.equip)
        if ref_total > 1e-6:
            opex_ratio = round(max(0.0, (1 - actual_total / ref_total) * 100), 1)
        else:
            opex_ratio = None

        # 多目标优化候选空间 + 后端预计算的帕累托前沿（见 _optimization_plan）：
        #   - byEquipment：按装备分组的"采矿点→出口"重载返程候选（前端渲染/选解用）；
        #   - stopes：采区摘要（全覆盖约束 / 品位下限 / 采场均衡目标）；
        #   - paretoFront / objectiveDefs / optStats：多目标算法在**后端**提前求好的结果，
        #     前端打开"多目标优化"板块直接消费，无需再在浏览器里跑 NSGA-III。
        optimization = self._optimization_plan()

        return {
            "schema": {
                "scenario": self.scenario_id,
                "engine": self.engine_name,
                "runId": self.run_id,
                "tickSec": self.dt,
                "timestamp": datetime.now().isoformat(),
                "simTimeSec": round(self.t, 1),
            },
            "factors": {
                "hardConstraints": {"desc": "巷道物理通过性（硬约束）", "segments": hard},
                "dynamicEnvironment": {"desc": "动态环境与感知（实时扰动）", **dynamic},
                "muckPile": {"desc": "矿岩散体堆积状态（作业对象）", "points": muck,
                             "recognitionCriterion": f">={int(BLOCK_RECOGNITION_THRESHOLD_CM)}cm识别率≥{int(BLOCK_RECOGNITION_RATE_REQ*100)}%"},
                "equipment": {"desc": "装备性能与能耗（经济性）",
                              "opexReductionTargetPct": OPEX_REDUCTION_TARGET,
                              "opexSimulatedSavePct": opex_ratio,
                              "units": "能量: kWh(电动)/L(柴油); 成本: 元", "items": equip},
                "optimization": optimization,
            },
        }

    # ---------- 爆破→调度爆堆信息注入（A4 契约） ----------
    def inject_blast_pile(self, pile: dict) -> bool:
        """注入爆破板块产生的爆堆信息（BlastPileInfo 契约），覆盖模拟兜底状态。

        字段对应爆破引擎输出：settledMassRatio/totalMassT/bigBlockRatio/sizeHist/shape
        /spreadR_m/heightM_m/gradePct/recognizeRate。爆破板块未实现时前端 blastPileAdapter
        返回 None 走 simulated 兜底，本方法保持幂等。
        """
        mid = pile.get("pileId") or pile.get("id")
        if mid not in self.muck:
            return False
        mp = self.muck[mid]
        if pile.get("source"):
            mp.source = pile["source"]
        if pile.get("blastCycle"):
            mp.blastCycle = pile["blastCycle"]
        if pile.get("shape"):
            mp.shape = pile["shape"]
        if pile.get("spreadR_m") is not None:
            mp.spreadR_m = float(pile["spreadR_m"])
        if pile.get("heightM_m") is not None:
            mp.heightM_m = float(pile["heightM_m"])
        if pile.get("bigBlockRatio") is not None:
            mp.bigBlockRatio = round(float(pile["bigBlockRatio"]), 2)
        if pile.get("sizeHist"):
            mp.sizeHist = pile["sizeHist"]
        if pile.get("gradePct") is not None:
            mp.gradePct = round(float(pile["gradePct"]), 3)
        if pile.get("recognizeRate") is not None:
            mp.recognize_rate = max(BLOCK_RECOGNITION_RATE_REQ, float(pile["recognizeRate"]))
        # 按新块度/识别率重算铲装耗时增量（与 _make_muck 同口径）
        mp.muckingEffort_min = round(2.5 + mp.bigBlockRatio * 0.35 + (0.95 - mp.recognize_rate) * 20.0, 2)
        # 若带总质量/存量信息则重置爆堆存量
        if pile.get("totalMassT") is not None:
            mp.stock_t = float(pile["totalMassT"])
            mp.initial_t = max(mp.initial_t, mp.stock_t)
            mp.inventory_pct = round(mp.stock_t / mp.initial_t * 100.0, 1) if mp.initial_t > 0 else 0.0
        return True

    def _find_equip(self, eq_id):
        for eq in self.equip:
            if eq.id == eq_id:
                return eq
        return None

    def tick(self):
        """推进一帧仿真相。”
        """
        self.t += self.dt
        self._update_dynamic()
        self._update_muck()
        self._move_equipment()
        return self.snapshot()


# 供调试的便捷构造
def build_default_simulator():
    return SchedulingSimulator()


def initial_snapshot() -> dict:
    sim = build_default_simulator()
    for _ in range(3):
        sim.tick()
    return sim.snapshot()