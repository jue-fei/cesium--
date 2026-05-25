export const EXPERIMENT_DEFAULT_CONFIG = {
  dataGeneration: {
    fieldSize: [200, 200, 100],
    pointCount: 150,
    testRatio: 0.3,
    seed: 2026,
    noiseLevel: 0.05,
    anomalyCount: 8,
    anomalyMagnitude: 2.0,
    trendType: 'gaussian_mixture'
  },
  comparison: {
    krigingModels: ['exponential'],
    idwConfig: {
      optimizeParameters: false,
      neighborPolicy: 'sector',
      sectorCount: 8
    },
    krigingConfig: {
      model: 'exponential'
    },
    gridResolution: 32,
    crossValidationFolds: 5,
    repeatCount: 5
  },
  metrics: ['rmse', 'mae', 'r2', 'maxError', 'mape'],
  chart: {
    colors: {
      idw: '#409EFF',
      kriging: '#67C23A',
      krigingGaussian: '#E6A23C',
      krigingSpherical: '#F56C6C'
    }
  }
}

export const EXPERIMENT_PRESETS = [
  {
    id: 'visual_contrast',
    label: '强对比可视化场景',
    description: '45 个稀疏采样点，梯度峰值应力场，三类 Kriging 模型同时对比，便于肉眼观察差异',
    config: {
      dataGeneration: {
        pointCount: 45,
        noiseLevel: 0.1,
        anomalyCount: 6,
        anomalyMagnitude: 2.2,
        trendType: 'gradient_peak'
      },
      comparison: {
        krigingModels: ['exponential', 'gaussian', 'spherical']
      }
    }
  },
  {
    id: 'small_dense',
    label: '小规模密集点',
    description: '100 个采样点，低噪声，适合验证基本插值精度',
    config: {
      dataGeneration: { pointCount: 100, noiseLevel: 0.02, anomalyCount: 3 }
    }
  },
  {
    id: 'medium_sparse',
    label: '中等规模稀疏点',
    description: '60 个采样点，中等噪声，模拟实际钻孔数据分布',
    config: {
      dataGeneration: { pointCount: 60, noiseLevel: 0.08, anomalyCount: 5 }
    }
  },
  {
    id: 'large_noisy',
    label: '大规模含噪点',
    description: '200 个采样点，高噪声+异常值，检验算法鲁棒性',
    config: {
      dataGeneration: {
        pointCount: 200,
        noiseLevel: 0.15,
        anomalyCount: 12,
        anomalyMagnitude: 2.5
      }
    }
  },
  {
    id: 'gradient_field',
    label: '梯度应力场',
    description: '线性梯度+高斯峰混合场，模拟真实地质应力分布',
    config: {
      dataGeneration: {
        pointCount: 150,
        noiseLevel: 0.05,
        anomalyCount: 6,
        trendType: 'gradient_peak'
      }
    }
  }
]

export const EXPERIMENT_DESIGN = {
  feasibility: {
    verdict: '可行，适合作为空间插值算法的仿真对比实验',
    scope:
      '实验使用可控合成应力场生成真值，再按统一训练/测试划分比较 IDW 默认、IDW-PSO 与 Kriging 模型，能够评估算法在相同数据条件下的相对精度、稳定性和耗时。',
    limitation:
      '结论属于仿真验证，能证明方法在设定应力场和噪声条件下的有效性；若用于工程定量结论，还需要接入真实钻孔、监测或反演数据进行外部验证。'
  },
  protocol: [
    '固定随机种子，保证同一预设下数据集可复现',
    '所有方法共享同一训练集和测试集，避免数据划分偏差',
    '采用 RMSE、MAE、R²、最大误差和 MAPE 多指标评价',
    '通过重复实验改变随机种子，报告均值、标准差和变异系数',
    '保留默认 IDW 作为基线，单独评估 PSO 参数优化收益'
  ],
  controls: [
    { label: '自变量', value: '插值方法与 Kriging 变异函数模型' },
    { label: '因变量', value: '预测误差、拟合优度、运行耗时' },
    { label: '控制变量', value: '采样点数、测试比例、噪声水平、异常点数量、应力场类型' },
    { label: '可靠性判据', value: '重复实验 RMSE 标准差越低、变异系数越低，结论越稳定' }
  ]
}

export const METHOD_LABELS = {
  idw: 'IDW（反距离加权）',
  kriging: 'Kriging（普通克里金）',
  idw_optimized: 'IDW-PSO（PSO优化）',
  idw_default: 'IDW（默认参数）',
  kriging_exponential: 'Kriging（指数模型）',
  kriging_gaussian: 'Kriging（高斯模型）',
  kriging_spherical: 'Kriging（球状模型）'
}

export const METHOD_INTRO = {
  idw: {
    title: 'IDW — 反距离加权插值',
    formula: 'Z(x) = Σ(wᵢ · Zᵢ) / Σwᵢ ， wᵢ = 1/d(x, xᵢ)ᵖ',
    description:
      'IDW（Inverse Distance Weighting）是一种确定性空间插值方法，核心假设是"距离越近的点对目标点的贡献越大"。幂指数 p 控制距离衰减速度：p 越大越偏向局部点（更尖锐），p 越小越平滑。本文使用 PSO 粒子群优化算法自动搜索最优幂指数和邻域数，避免人工试参的主观性。'
  },
  kriging: {
    title: 'Kriging — 克里金插值',
    formula: 'Z*(x) = Σλᵢ · Z(xᵢ)， λ = K⁻¹k',
    description:
      'Kriging 是一种基于变异函数（Variogram）的最优线性无偏估计方法。与 IDW 不同，Kriging 不仅考虑距离，还考虑空间数据的相关性结构，通过拟合变异函数模型来量化不同距离上的空间变异性。普通克里金假定区域化变量满足二阶平稳假设，能提供插值方差作为不确定性度量。'
  },
  kriging_variogram: {
    exponential: {
      label: '指数模型',
      formula: 'γ(h) = C₀ + C₁[1 − exp(−3h/a)]',
      description: '空间相关性随距离指数衰减，适合连续渐变的应力场'
    },
    gaussian: {
      label: '高斯模型',
      formula: 'γ(h) = C₀ + C₁[1 − exp(−3h²/a²)]',
      description: '近距相关性更强（抛物线起点），适合高度平滑的地质场'
    },
    spherical: {
      label: '球状模型',
      formula: 'γ(h) = C₀ + C₁[1.5(h/a) − 0.5(h/a)³]（h≤a时）',
      description: '到达变程 a 后相关为零，适合具有明显影响半径的矿体'
    }
  }
}

export const METRIC_INTRO = {
  rmse: {
    label: 'RMSE 均方根误差',
    description: '误差平方均值的平方根，对异常值敏感。值越小插值精度越高。',
    ranking: '核心指标，越小越好'
  },
  mae: {
    label: 'MAE 平均绝对误差',
    description: '误差绝对值的均值，直观反映平均偏差大小。',
    ranking: '越小越好'
  },
  r2: {
    label: 'R² 决定系数',
    description: '衡量插值结果对真实值变异性的解释程度。越接近 1 拟合越好。',
    ranking: '越接近1越好'
  },
  maxError: {
    label: '最大误差',
    description: '所有测试点中插值偏差的最大值，反映最坏情况。',
    ranking: '越小越好'
  },
  mape: {
    label: 'MAPE 百分比误差',
    description: '相对误差的均值百分比，便于跨尺度对比。',
    ranking: '越小越好'
  }
}

export const PARAM_INTRO = {
  pointCount: '合成数据集的采样点总数，影响插值密度与实验耗时',
  testRatio: '用于评估的测试集占比，剩余部分作为训练集构建插值模型',
  noiseLevel: '叠加在真实值上的高斯噪声标准差占比，模拟测量误差',
  anomalyCount: '额外注入的异常点数量，其值为真值的数倍，检验算法抗干扰能力',
  krigingModels: '克里金插值使用的变异函数模型类型，可同时选择多个进行比较'
}

export const METRIC_LABELS = {
  rmse: 'RMSE（均方根误差）',
  mae: 'MAE（平均绝对误差）',
  r2: 'R²（决定系数）',
  maxError: '最大误差',
  mape: 'MAPE（平均绝对百分比误差）'
}

export const METRIC_UNITS = {
  rmse: 'MPa',
  mae: 'MPa',
  r2: '',
  maxError: 'MPa',
  mape: '%'
}

export const EXPERIMENT_PHASES = [
  { key: 'generating', label: '生成测试数据' },
  { key: 'splitting', label: '划分训练/测试集' },
  { key: 'idw_benchmark', label: 'IDW插值基准测试' },
  { key: 'idw_default', label: 'IDW默认基线测试' },
  { key: 'kriging_benchmark', label: 'Kriging插值基准测试' },
  { key: 'computing_metrics', label: '计算评估指标' },
  { key: 'rendering_heatmaps', label: '生成热力图快照' },
  { key: 'repeat', label: '重复实验统计' },
  { key: 'done', label: '实验完成' }
]
