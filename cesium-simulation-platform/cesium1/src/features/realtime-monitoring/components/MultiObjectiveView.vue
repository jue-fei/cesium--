<template>
  <div class="moo-view">
    <!-- NSGA-III 控制栏 -->
    <div class="control-panel">
      <div class="panel-title">NSGA-III 多目标调度优化</div>
      <div class="panel-subtitle">
        面向多目标、多参数路径调度场景，联合评估运输距离、运输时间、燃油消耗、
        作业安全与重载通行适配性
      </div>
      <div class="config-grid">
        <div class="config-item">
          <span class="config-label">调度偏好</span>
          <el-select v-model="preferencePreset" size="small" class="config-select">
            <el-option
              v-for="option in preferenceOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </div>
        <div class="config-item">
          <span class="config-label">中继点数</span>
          <el-select v-model="optimizationConfig.numWaypoints" size="small" class="config-select">
            <el-option
              v-for="count in waypointOptions"
              :key="count"
              :label="`${count} 个`"
              :value="count"
            />
          </el-select>
        </div>
        <div class="config-item">
          <span class="config-label">进化代数</span>
          <el-select v-model="optimizationConfig.generations" size="small" class="config-select">
            <el-option
              v-for="count in generationOptions"
              :key="count"
              :label="`${count} 代`"
              :value="count"
            />
          </el-select>
        </div>
        <div class="config-item">
          <span class="config-label">参考方向</span>
          <el-select
            v-model="optimizationConfig.referenceDivisions"
            size="small"
            class="config-select"
          >
            <el-option
              v-for="count in referenceDivisionOptions"
              :key="count"
              :label="`${count} 阶划分`"
              :value="count"
            />
          </el-select>
        </div>
      </div>
      <div class="config-tags">
        <span class="config-tag">算法: NSGA-III</span>
        <span class="config-tag">目标数: {{ objectives.length }}</span>
        <span class="config-tag">参数维度: {{ decisionDimensions }}</span>
        <span class="config-tag">偏好: {{ activePreference.label }}</span>
      </div>
      <el-button
        size="small"
        :type="running ? 'warning' : 'success'"
        :loading="running"
        :disabled="running"
        style="width: 100%"
        @click="runOptimization"
      >
        {{ running ? `优化计算中 ${genProgress}/${totalGens}` : '执行 NSGA-III 优化' }}
      </el-button>
      <div v-if="running" class="gen-bar">
        <div class="gen-fill" :style="{ width: (genProgress / totalGens) * 100 + '%' }"></div>
      </div>
    </div>

    <!-- 图例 -->
    <div v-if="paretoStats" class="legend-bar">
      <span class="legend-item"
        ><span class="legend-dot legend-line-dot"></span>Pareto 前沿投影</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background: #67c23a"></span>{{ levelLegend.primary }}</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background: #e6a23c"></span
        >{{ levelLegend.secondary }}</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background: #4a5568"></span
        >{{ levelLegend.tertiary }}</span
      >
    </div>

    <!-- Pareto前沿统计 -->
    <div v-if="paretoStats" class="stats-panel">
      <div class="section-header">
        <span>种群统计</span>
        <el-tag size="small" type="success">{{ paretoStats.paretoSize }} 个 Pareto 最优解</el-tag>
      </div>
      <div class="stats-grid">
        <div v-for="obj in objectives" :key="obj.id" class="stat-item">
          <span class="stat-label" :style="{ color: obj.color }">{{ obj.nameShort }}</span>
          <span class="stat-range"
            >{{ fmt(paretoStats.objectiveRanges[obj.id]?.min) }}~{{
              fmt(paretoStats.objectiveRanges[obj.id]?.max)
            }}</span
          >
        </div>
      </div>
      <div class="stats-extra">
        <span>算法: {{ paretoStats.algorithm }}</span>
        <span>总个体: {{ paretoStats.populationSize }}</span>
        <span>前沿数: {{ paretoStats.numFronts }}</span>
        <span>代数: {{ optimizationConfig.generations }}</span>
      </div>
    </div>

    <div v-if="paretoStats" class="experiment-panel">
      <div class="section-header">
        <span>调度实验概览</span>
        <el-tag size="small" type="info">{{ activePreference.label }}</el-tag>
      </div>
      <div class="experiment-grid">
        <div class="experiment-card">
          <div class="experiment-title">实验配置</div>
          <div class="experiment-line">求解算法: {{ paretoStats.algorithm }}</div>
          <div class="experiment-line">目标数量: {{ paretoStats.objectiveCount }}</div>
          <div class="experiment-line">参数维度: {{ paretoStats.decisionDimensions }}</div>
          <div class="experiment-line">中继点数: {{ paretoStats.numWaypoints }}</div>
          <div class="experiment-line">标准参考方向: {{ paretoStats.referencePointCount }}</div>
          <div class="experiment-line">实际参考方向: {{ paretoStats.effectiveReferenceCount }}</div>
        </div>
        <div class="experiment-card">
          <div class="experiment-title">策略说明</div>
          <div class="experiment-desc">{{ activePreference.description }}</div>
          <div class="experiment-line">适用场景: {{ activePreference.scene }}</div>
          <div class="experiment-line">推荐选解: {{ recommendationTitle }}</div>
          <div class="experiment-line">{{ recommendationHint }}</div>
        </div>
      </div>
    </div>

    <div v-if="allPopulation.length > 0" class="recommendation-panel">
      <div class="section-header">
        <span>代表方案卡片</span>
        <span class="section-note">按当前偏好与典型调度目标提取可直接比选的方案</span>
      </div>
      <div class="recommendation-grid">
        <button
          v-for="plan in representativePlans"
          :key="plan.id"
          type="button"
          class="recommendation-card"
          :class="{ 'recommendation-card-active': plan.individual === selectedPath }"
          @click="selectPath(plan.individual)"
        >
          <div class="recommendation-head">
            <span class="recommendation-title">{{ plan.title }}</span>
            <span
              class="recommendation-badge"
              :style="{ background: rankColor(displayRank(plan.individual)) }"
            >
              {{ getDisplayLevelShort(plan.individual) }}
            </span>
          </div>
          <div class="recommendation-desc">{{ plan.description }}</div>
          <div class="recommendation-metrics">
            <span>{{ fmt(plan.individual.objectives.d) }} km</span>
            <span>{{ fmt(plan.individual.objectives.t) }} min</span>
            <span>{{ fmt(plan.individual.objectives.s) }} 分</span>
          </div>
          <div class="recommendation-metrics">
            <span>油耗 {{ fmt(plan.individual.objectives.f) }} L</span>
            <span>重载 {{ fmt(plan.individual.objectives.l) }} 分</span>
            <span>{{ plan.focus }}</span>
          </div>
        </button>
      </div>
    </div>

    <div v-if="allPopulation.length > 0" class="parallel-panel">
      <div class="section-header">
        <span>多目标权衡视图</span>
        <span class="section-note">纵向越高代表综合表现越优，已按目标方向统一归一化</span>
      </div>
      <div class="parallel-viz">
        <svg :viewBox="`0 0 ${parallelW} ${parallelH}`" class="parallel-svg">
          <g v-for="axis in parallelAxes" :key="axis.id">
            <line
              :x1="axis.x"
              :y1="parallelPadTop"
              :x2="axis.x"
              :y2="parallelH - parallelPadBottom"
              stroke="#314155"
              stroke-width="1"
            />
            <text
              :x="axis.x"
              :y="14"
              text-anchor="middle"
              fill="#d9e4ef"
              font-size="9"
              font-weight="600"
            >
              {{ axis.nameShort }}
            </text>
            <text :x="axis.x" :y="26" text-anchor="middle" fill="#67C23A" font-size="7">
              优 {{ formatValue(axis.best, axis) }}
            </text>
            <text :x="axis.x" :y="parallelH - 6" text-anchor="middle" fill="#718096" font-size="7">
              劣 {{ formatValue(axis.worst, axis) }}
            </text>
          </g>
          <polyline
            v-for="(ind, idx) in allPopulation"
            :key="`pl-${idx}`"
            :points="getParallelPoints(ind)"
            fill="none"
            :stroke="ind === selectedPath ? '#409EFF' : rankColor(displayRank(ind))"
            :stroke-width="ind === selectedPath ? 2.2 : displayRank(ind) === 0 ? 1.2 : 0.8"
            :opacity="ind === selectedPath ? 0.95 : displayRank(ind) === 0 ? 0.55 : 0.22"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <div class="parallel-footer">
        <span
          >当前高亮:
          {{ selectedPath ? recommendationHint : '请在方案卡片、表格或路径图中选择方案' }}</span
        >
      </div>
    </div>

    <!-- 双目标投影视图 (辅助分析) -->
    <div v-if="allPopulation.length > 0" class="scatter-panel">
      <div class="section-header">
        <span>双目标投影视图</span>
        <div class="axis-selects">
          <el-select v-model="scatterX" size="small" style="width: 56px">
            <el-option v-for="o in objectives" :key="o.id" :label="o.nameShort" :value="o.id" />
          </el-select>
          <span style="color: #718096; font-size: 10px">×</span>
          <el-select v-model="scatterY" size="small" style="width: 56px">
            <el-option v-for="o in objectives" :key="o.id" :label="o.nameShort" :value="o.id" />
          </el-select>
        </div>
      </div>
      <div class="scatter-viz">
        <svg :viewBox="`0 0 ${scatterW} ${scatterH}`" class="scatter-svg">
          <!-- 网格 -->
          <g v-for="i in 5" :key="`sg-${i}`">
            <line
              :x1="scatterPad"
              :y1="scatterPad + (i - 1) * scatterGridH"
              :x2="scatterW - scatterPadR"
              :y2="scatterPad + (i - 1) * scatterGridH"
              stroke="#2d3748"
              stroke-width="0.4"
            />
            <line
              :x1="scatterPad + (i - 1) * scatterGridW"
              :y1="scatterPad"
              :x2="scatterPad + (i - 1) * scatterGridW"
              :y2="scatterH - scatterPadB"
              stroke="#2d3748"
              stroke-width="0.4"
            />
          </g>
          <!-- 全部个体散点 -->
          <g v-for="(ind, idx) in allPopulation" :key="`sp-${idx}`">
            <circle
              :cx="scatterXPos(ind)"
              :cy="scatterYPos(ind)"
              :r="ind === selectedPath ? 3.5 : displayRank(ind) === 0 ? 2.5 : 1.5"
              :fill="rankColor(displayRank(ind))"
              :opacity="ind === selectedPath ? 1 : displayRank(ind) === 0 ? 0.9 : 0.5"
              :stroke="ind === selectedPath ? '#fff' : 'none'"
              :stroke-width="ind === selectedPath ? 1.5 : 0"
              style="cursor: pointer"
              @click="selectPath(ind)"
            />
          </g>
          <!-- Pareto前沿连线 (Rank 0) -->
          <polyline
            v-if="paretoLinePoints"
            :points="paretoLinePoints"
            fill="none"
            stroke="#67C23A"
            stroke-width="1.8"
            stroke-dasharray="4,2"
            opacity="0.7"
          />
          <!-- 轴标签 -->
          <text
            :x="scatterW / 2"
            :y="scatterH - 4"
            text-anchor="middle"
            fill="#a0aec0"
            font-size="9"
          >
            {{ scatterXObj.nameShort }} ({{ scatterXObj.unit }})
          </text>
          <text
            :x="6"
            :y="scatterH / 2"
            text-anchor="middle"
            fill="#a0aec0"
            font-size="9"
            transform-origin="center"
            :transform="`rotate(-90, 6, ${scatterH / 2})`"
          >
            {{ scatterYObj.nameShort }} ({{ scatterYObj.unit }})
          </text>
          <!-- 轴刻度 -->
          <text
            v-for="(t, i) in xTicks"
            :key="`xt-${i}`"
            :x="scatterPad + i * scatterGridW"
            :y="scatterH - scatterPadB + 12"
            text-anchor="middle"
            fill="#718096"
            font-size="7"
          >
            {{ t }}
          </text>
          <text
            v-for="(t, i) in yTicks"
            :key="`yt-${i}`"
            :x="scatterPad - 6"
            :y="scatterPad + (4 - i) * scatterGridH + 3"
            text-anchor="end"
            fill="#718096"
            font-size="7"
          >
            {{ t }}
          </text>
        </svg>
      </div>
      <div class="scatter-info">
        <span
          >X: {{ scatterXObj.nameShort }} ({{ fmt(scatterXRange.min) }}~{{
            fmt(scatterXRange.max)
          }})</span
        >
        <span
          >Y: {{ scatterYObj.nameShort }} ({{ fmt(scatterYRange.min) }}~{{
            fmt(scatterYRange.max)
          }})</span
        >
        <span>用途: 用于观察两个目标之间的局部权衡关系</span>
      </div>
    </div>

    <!-- 路径可视化 (全部个体，按rank分层着色) -->
    <div class="viz-panel">
      <div class="section-header">
        <span>仿真候选路径分布</span>
        <el-tag size="small" :type="allPopulation.length > 0 ? 'success' : 'info'">
          {{ allPopulation.length > 0 ? allPopulation.length + ' 个个体' : '待优化' }}
        </el-tag>
      </div>
      <div class="path-viz">
        <svg viewBox="0 0 280 160" class="path-svg">
          <g v-for="i in 5" :key="`g-${i}`">
            <line :x1="0" :y1="i * 32" :x2="280" :y2="i * 32" stroke="#2d3748" stroke-width="0.5" />
            <line :x1="i * 56" :y1="0" :x2="i * 56" :y2="160" stroke="#2d3748" stroke-width="0.5" />
          </g>
          <g v-for="(ind, idx) in rankGroup[3]" :key="`r3-${idx}`">
            <polyline
              :points="pathPoints(ind)"
              fill="none"
              stroke="#4a5568"
              :stroke-width="ind === selectedPath ? 2.5 : 0.5"
              :opacity="ind === selectedPath ? 0.9 : 0.18"
            />
          </g>
          <g v-for="(ind, idx) in rankGroup[2]" :key="`r2-${idx}`">
            <polyline
              :points="pathPoints(ind)"
              fill="none"
              stroke="#E6A23C"
              :stroke-width="ind === selectedPath ? 2.5 : 0.6"
              :opacity="ind === selectedPath ? 0.9 : 0.35"
            />
          </g>
          <g v-for="(ind, idx) in rankGroup[1]" :key="`r1-${idx}`">
            <polyline
              :points="pathPoints(ind)"
              fill="none"
              stroke="#67C23A"
              :stroke-width="ind === selectedPath ? 3 : 1.2"
              :opacity="ind === selectedPath ? 1 : 0.7"
            />
          </g>
          <circle :cx="35" :cy="125" r="6" fill="#409EFF" />
          <text
            :x="35"
            :y="115"
            text-anchor="middle"
            fill="#409EFF"
            font-size="9"
            font-weight="bold"
          >
            起
          </text>
          <circle :cx="245" :cy="35" r="6" fill="#F56C6C" />
          <text
            :x="245"
            :y="25"
            text-anchor="middle"
            fill="#F56C6C"
            font-size="9"
            font-weight="bold"
          >
            终
          </text>
        </svg>
        <div v-if="selectedPath" class="path-info">
          <div>
            显示层级:
            <b :style="{ color: rankColor(displayRank(selectedPath)) }">{{
              getDisplayLevelLabel(selectedPath)
            }}</b>
          </div>
          <div>
            拥挤距离:
            <b>{{
              selectedPath.crowdingDistance >= 1e9 ? '∞' : selectedPath.crowdingDistance.toFixed(3)
            }}</b>
          </div>
        </div>
      </div>
    </div>

    <!-- 雷达图 -->
    <div class="radar-panel">
      <div class="section-header">目标表现雷达图</div>
      <div class="radar-viz">
        <svg viewBox="0 0 140 140" class="radar-svg">
          <g v-for="i in 4" :key="`c-${i}`">
            <circle :cx="70" :cy="70" :r="i * 14" fill="none" stroke="#4a5568" stroke-width="0.5" />
          </g>
          <g v-for="(obj, i) in objectives" :key="`a-${i}`">
            <line
              :x1="70"
              :y1="70"
              :x2="70 + 45 * Math.cos(((i * 72 - 90) * Math.PI) / 180)"
              :y2="70 + 45 * Math.sin(((i * 72 - 90) * Math.PI) / 180)"
              stroke="#4a5568"
              stroke-width="0.5"
            />
            <text
              :x="70 + 58 * Math.cos(((i * 72 - 90) * Math.PI) / 180)"
              :y="70 + 58 * Math.sin(((i * 72 - 90) * Math.PI) / 180)"
              text-anchor="middle"
              fill="#a0aec0"
              font-size="8"
            >
              {{ obj.nameShort }}
            </text>
          </g>
          <polygon
            v-if="paretoStats"
            :points="getRadarPoints('best')"
            fill="rgba(103,194,58,0.25)"
            stroke="#67C23A"
            stroke-width="1.5"
          />
          <polygon
            v-if="paretoStats"
            :points="getRadarPoints('worst')"
            fill="rgba(245,108,108,0.08)"
            stroke="#F56C6C"
            stroke-width="0.8"
            stroke-dasharray="2,2"
          />
          <polygon
            v-if="selectedPath"
            :points="getRadarPoints('selected')"
            fill="rgba(64,158,255,0.15)"
            stroke="#409EFF"
            stroke-width="1.5"
          />
        </svg>
      </div>
      <div v-if="selectedPath" class="obj-list">
        <div v-for="obj in objectives" :key="obj.id" class="obj-row">
          <div class="obj-info">
            <span class="dot" :style="{ background: obj.color }"></span>
            <span>{{ obj.nameShort }}</span>
            <span :style="{ color: obj.color }">{{
              formatValue(selectedPath.objectives[obj.id], obj)
            }}</span>
          </div>
          <el-progress
            :percentage="getBestPercent(selectedPath.objectives[obj.id], obj)"
            :color="obj.color"
            :stroke-width="3"
            :show-text="false"
          />
        </div>
      </div>
    </div>

    <!-- 选中个体详情面板 -->
    <div v-if="selectedPath" class="detail-panel">
      <div class="section-header">
        <span>选中方案详情</span>
        <el-tag
          size="small"
          :style="{
            background: rankColor(displayRank(selectedPath)),
            color: displayRank(selectedPath) === 0 ? '#1a1a2e' : '#fff',
            border: 'none'
          }"
        >
          {{ getDisplayLevelShort(selectedPath) }}
        </el-tag>
      </div>
      <!-- 目标值 -->
      <div class="detail-objs">
        <div v-for="obj in objectives" :key="obj.id" class="detail-obj-row">
          <span class="detail-obj-dot" :style="{ background: obj.color }"></span>
          <span class="detail-obj-name">{{ obj.name }}</span>
          <span class="detail-obj-val" :style="{ color: obj.color }"
            >{{ fmt(selectedPath.objectives[obj.id]) }} {{ obj.unit }}</span
          >
          <span class="detail-obj-dir">{{ obj.dir === 'min' ? '↓' : '↑' }}</span>
        </div>
      </div>
      <!-- 影响参数 -->
      <div v-if="selectedPath.objectives._params" class="detail-params">
        <div class="detail-subtitle">路径特征参数</div>
        <div class="params-grid">
          <div class="param-item">
            <span class="param-label">路径里程</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.routeLen) }} km</span>
            <span class="param-desc">路径总长度</span>
          </div>
          <div class="param-item">
            <span class="param-label">最大坡度</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.maxGrade) }}%</span>
            <span class="param-desc">路径中最大坡度</span>
          </div>
          <div class="param-item">
            <span class="param-label">平均坡度</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.avgGrade) }}%</span>
            <span class="param-desc">沿路径加权平均坡度</span>
          </div>
          <div class="param-item">
            <span class="param-label">平均速度</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.avgSpeed) }} km/h</span>
            <span class="param-desc">考虑坡度与弯道折减后的等效均速</span>
          </div>
          <div class="param-item">
            <span class="param-label">累计转角</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.totalTurnDeg) }}°</span>
            <span class="param-desc">全路径转角总和</span>
          </div>
          <div class="param-item">
            <span class="param-label">最小转弯半径</span>
            <span class="param-val"
              >{{ fmt(selectedPath.objectives._params.minTurnRadiusM) }} m</span
            >
            <span class="param-desc">最小几何转弯半径</span>
          </div>
          <div class="param-item">
            <span class="param-label">危险暴露度</span>
            <span class="param-val">{{
              selectedPath.objectives._params.hazardExposure.toFixed(3)
            }}</span>
            <span class="param-desc">单位里程平均风险暴露</span>
          </div>
          <div class="param-item">
            <span class="param-label">路面质量</span>
            <span class="param-val">{{ fmt(selectedPath.objectives._params.roadQuality) }}</span>
            <span class="param-desc">沿线平均路况质量（0~1）</span>
          </div>
          <div class="param-item">
            <span class="param-label">急弯数量</span>
            <span class="param-val">{{ selectedPath.objectives._params.numSharpTurns }}</span>
            <span class="param-desc">&gt;30°急弯数量</span>
          </div>
          <div class="param-item">
            <span class="param-label">拥挤距离</span>
            <span class="param-val">{{
              selectedPath.crowdingDistance >= 1e9 ? '∞' : selectedPath.crowdingDistance.toFixed(3)
            }}</span>
            <span class="param-desc">Pareto 解集中的分散程度</span>
          </div>
        </div>
      </div>
      <!-- 路径点坐标 -->
      <div class="detail-waypoints">
        <div class="detail-subtitle">
          路径点坐标 ({{ selectedPath.waypoints.length }} 个点)
          <span class="wp-note">起点→中继点→终点</span>
        </div>
        <div class="waypoints-grid">
          <div
            v-for="(wp, i) in selectedPath.waypoints"
            :key="`wp-${i}`"
            class="wp-item"
            :class="{ 'wp-endpoint': i === 0 || i === selectedPath.waypoints.length - 1 }"
          >
            <span class="wp-idx">{{
              i === 0 ? '起' : i === selectedPath.waypoints.length - 1 ? '终' : i
            }}</span>
            <span class="wp-coord">({{ wp.x.toFixed(1) }}, {{ wp.y.toFixed(1) }})</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 全部个体信息表 -->
    <div v-if="allPopulation.length > 0" class="list-panel">
      <div class="section-header">
        <span>候选解列表 ({{ allPopulation.length }})</span>
        <span style="font-size: 10px; color: #718096">点击行查看方案详情</span>
      </div>
      <div class="table-scroll">
        <table class="ind-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-r">层级</th>
              <th class="col-cd">拥挤距离</th>
              <th
                v-for="obj in objectives"
                :key="obj.id"
                class="col-obj"
                :style="{ color: obj.color }"
              >
                {{ obj.nameShort }}
                <span class="th-unit">{{ obj.unit }}</span>
              </th>
              <th class="col-param">里程km</th>
              <th class="col-param">坡度%</th>
              <th class="col-param">危险度</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(ind, idx) in sortedPopulation"
              :key="`row-${idx}`"
              :class="{ 'row-sel': ind === selectedPath, 'row-r1': displayRank(ind) === 0 }"
              @click="selectPath(ind)"
            >
              <td class="col-num">{{ idx + 1 }}</td>
              <td class="col-r">
                <span
                  class="rank-badge"
                  :style="{
                    background: rankColor(displayRank(ind)),
                    color: displayRank(ind) === 0 ? '#1a1a2e' : '#fff'
                  }"
                >
                  {{ getDisplayLevelShort(ind) }}
                </span>
              </td>
              <td class="col-cd" :class="{ 'cd-inf': ind.crowdingDistance >= 1e9 }">
                {{ ind.crowdingDistance >= 1e9 ? '∞' : ind.crowdingDistance.toFixed(2) }}
              </td>
              <td v-for="obj in objectives" :key="obj.id" class="col-obj">
                {{ fmt(ind.objectives[obj.id]) }}
              </td>
              <td class="col-param">
                {{ ind.objectives._params ? fmt(ind.objectives._params.routeLen) : '-' }}
              </td>
              <td class="col-param">
                {{ ind.objectives._params ? fmt(ind.objectives._params.maxGrade) : '-' }}
              </td>
              <td class="col-param">
                {{
                  ind.objectives._params ? ind.objectives._params.hazardExposure.toFixed(2) : '-'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="rank-summary">
        <span
          v-for="entry in sortedRankEntries"
          v-show="entry.size > 0"
          :key="'rs-' + entry.rankKey"
          class="rs-item"
        >
          <span class="rs-dot" :style="{ background: rankColor(entry.level) }"></span>
          {{ getSummaryLabel(entry.level) }}: {{ entry.size }}个
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { runNSGA3, OBJECTIVES, DEFAULT_CONFIG } from '../services/nsga3Core.js'
import { logger } from '@/utils/logger.js'

defineOptions({ name: 'MultiObjectiveView' })

const OBJECTIVE_META = {
  d: { nameShort: '距离', color: '#409EFF', max: 10, unit: 'km' },
  t: { nameShort: '时间', color: '#67C23A', max: 30, unit: 'min' },
  f: { nameShort: '油耗', color: '#E6A23C', max: 80, unit: 'L' },
  s: { nameShort: '安全', color: '#F56C6C', max: 100, unit: '分' },
  l: { nameShort: '重载', color: '#909399', max: 100, unit: '分' }
}

const objectives = computed(() =>
  OBJECTIVES.map(objective => ({
    ...objective,
    ...OBJECTIVE_META[objective.id]
  }))
)

const preferenceOptions = [
  { value: 'balanced', label: '均衡调度' },
  { value: 'safe', label: '安全优先' },
  { value: 'efficiency', label: '效率优先' },
  { value: 'heavyLoad', label: '重载优先' }
]

const preferenceProfiles = {
  balanced: {
    label: '均衡调度',
    scene: '综合生产场景',
    description: '在效率、能耗、安全和重载适配之间寻求稳健折中，适合常规生产组织。',
    weights: { d: 0.2, t: 0.25, f: 0.2, s: 0.2, l: 0.15 }
  },
  safe: {
    label: '安全优先',
    scene: '风险敏感时段',
    description: '优先规避危险暴露与极端坡度，适合爆破后、雨季和设备交叉频繁时段。',
    weights: { d: 0.1, t: 0.15, f: 0.1, s: 0.4, l: 0.25 }
  },
  efficiency: {
    label: '效率优先',
    scene: '抢装抢运场景',
    description: '优先缩短运输时长和路径长度，适合高节拍生产或短时抢运任务。',
    weights: { d: 0.25, t: 0.35, f: 0.15, s: 0.15, l: 0.1 }
  },
  heavyLoad: {
    label: '重载优先',
    scene: '高负载运输场景',
    description: '优先选择坡度更缓、弯道更友好的路线，适合满载矿卡连续运行。',
    weights: { d: 0.1, t: 0.15, f: 0.15, s: 0.2, l: 0.4 }
  }
}

const waypointOptions = [4, 6, 8]
const generationOptions = [60, 90, 120]
const referenceDivisionOptions = [3, 4, 5]

const running = ref(false)
const genProgress = ref(0)
const totalGens = ref(80)
const allPopulation = ref([])
const paretoStats = ref(null)
const selectedPath = ref(null)
const preferencePreset = ref('balanced')

const optimizationConfig = reactive({
  ...DEFAULT_CONFIG
})

const activePreference = computed(() => preferenceProfiles[preferencePreset.value])
const decisionDimensions = computed(() => optimizationConfig.numWaypoints * 2)

// 散点图坐标轴选择
const scatterX = ref('d')
const scatterY = ref('t')

const scatterW = 280
const scatterH = 180
const scatterPad = 30
const scatterPadR = 8
const scatterPadB = 22
const scatterGridW = (scatterW - scatterPad - scatterPadR) / 4
const scatterGridH = (scatterH - scatterPad - scatterPadB) / 4

const parallelW = 320
const parallelH = 180
const parallelPadTop = 34
const parallelPadBottom = 22
const parallelPadX = 26

const scatterXObj = computed(() => objectives.value.find(o => o.id === scatterX.value))
const scatterYObj = computed(() => objectives.value.find(o => o.id === scatterY.value))

const objectiveRanges = computed(() => buildObjectiveRanges(allPopulation.value))

const parallelAxes = computed(() => {
  const count = objectives.value.length
  const width = parallelW - parallelPadX * 2
  const step = count > 1 ? width / (count - 1) : 0
  return objectives.value.map((objective, index) => {
    const range = objectiveRanges.value[objective.id] || { min: 0, max: 0 }
    const best = objective.dir === 'min' ? range.min : range.max
    const worst = objective.dir === 'min' ? range.max : range.min
    return {
      ...objective,
      x: parallelPadX + step * index,
      best,
      worst
    }
  })
})

const scatterXRange = computed(() => {
  if (allPopulation.value.length === 0) return { min: 0, max: 100 }
  let min = Infinity,
    max = -Infinity
  for (const ind of allPopulation.value) {
    const v = ind.objectives[scatterX.value]
    if (v < min) min = v
    if (v > max) max = v
  }
  const pad = (max - min) * 0.05 || 1
  return { min: Math.floor(min - pad), max: Math.ceil(max + pad) }
})

const scatterYRange = computed(() => {
  if (allPopulation.value.length === 0) return { min: 0, max: 100 }
  let min = Infinity,
    max = -Infinity
  for (const ind of allPopulation.value) {
    const v = ind.objectives[scatterY.value]
    if (v < min) min = v
    if (v > max) max = v
  }
  const pad = (max - min) * 0.05 || 1
  return { min: Math.floor(min - pad), max: Math.ceil(max + pad) }
})

const xTicks = computed(() => {
  const { min, max } = scatterXRange.value
  const step = (max - min) / 4
  return [0, 1, 2, 3, 4].map(i => (min + step * i).toFixed(1))
})

const yTicks = computed(() => {
  const { min, max } = scatterYRange.value
  const step = (max - min) / 4
  return [0, 1, 2, 3, 4].map(i => (min + step * i).toFixed(1))
})

function xNorm(v) {
  const { min, max } = scatterXRange.value
  return max === min ? 0.5 : (v - min) / (max - min)
}

function yNorm(v) {
  const { min, max } = scatterYRange.value
  return max === min ? 0.5 : (v - min) / (max - min)
}

function scatterXPos(ind) {
  return scatterPad + xNorm(ind.objectives[scatterX.value]) * scatterGridW * 4
}

function scatterYPos(ind) {
  return scatterPad + (1 - yNorm(ind.objectives[scatterY.value])) * scatterGridH * 4
}

// PF连线：取真实 Rank 0（非支配）个体，在其 2D 投影中取包络线后连接
const paretoLinePoints = computed(() => {
  const pf = allPopulation.value.filter(ind => ind.rank === 0)
  if (pf.length < 2) return null

  const xDir = scatterXObj.value.dir
  const yDir = scatterYObj.value.dir

  // 统一转为"最小化"方向
  const pts = pf.map(ind => ({
    xn: xDir === 'min' ? ind.objectives[scatterX.value] : -ind.objectives[scatterX.value],
    yn: yDir === 'min' ? ind.objectives[scatterY.value] : -ind.objectives[scatterY.value],
    orig: ind
  }))
  pts.sort((a, b) => a.xn - b.xn)

  // 在PF内做2D扫描线包络
  const front = []
  let bestYn = Infinity
  for (const p of pts) {
    if (p.yn < bestYn - 1e-9 || front.length === 0) {
      front.push(p.orig)
      bestYn = p.yn
    }
  }

  if (front.length < 2) return null
  return front.map(ind => `${scatterXPos(ind)},${scatterYPos(ind)}`).join(' ')
})

// 当全部个体都是Rank 0时，用拥挤距离分档来提供视觉层次
const useCrowdingTiers = computed(
  () => allPopulation.value.length > 0 && allPopulation.value.every(ind => ind.rank === 0)
)

const crowdingTierMap = computed(() => {
  if (!useCrowdingTiers.value) return null
  const map = new Map()
  const sorted = [...allPopulation.value].sort((a, b) => b.crowdingDistance - a.crowdingDistance)
  const n = sorted.length
  const t1 = Math.ceil(n * 0.3),
    t2 = Math.ceil(n * 0.65)
  sorted.forEach((ind, i) => {
    if (i < t1) map.set(ind, 0)
    else if (i < t2) map.set(ind, 1)
    else map.set(ind, 2)
  })
  return map
})

const levelLegend = computed(() => {
  if (!useCrowdingTiers.value) {
    return {
      primary: '第 1 前沿（非支配）',
      secondary: '第 2 前沿',
      tertiary: '第 3 前沿及以后'
    }
  }

  return {
    primary: 'Pareto 解集高分散档',
    secondary: 'Pareto 解集中分散档',
    tertiary: 'Pareto 解集稠密档'
  }
})

function displayRank(ind) {
  if (!useCrowdingTiers.value) return ind.rank
  return crowdingTierMap.value?.get(ind) ?? 2
}

function rankColor(r) {
  if (r === 0) return '#67C23A'
  if (r === 1) return '#E6A23C'
  return '#4a5568'
}

function getDisplayLevelShort(ind) {
  const level = displayRank(ind)
  if (useCrowdingTiers.value) return ['A档', 'B档', 'C档'][level] || 'C档'
  return `F${level + 1}`
}

function getDisplayLevelLabel(ind) {
  const level = displayRank(ind)
  if (useCrowdingTiers.value) {
    return ['Pareto 高分散档', 'Pareto 中分散档', 'Pareto 稠密档'][level] || 'Pareto 稠密档'
  }
  return `第 ${level + 1} 前沿`
}

function getSummaryLabel(level) {
  if (useCrowdingTiers.value) return ['高分散档', '中分散档', '稠密档'][level] || '稠密档'
  return ['F1', 'F2', 'F3+'][level] || 'F3+'
}

const rankGroup = computed(() => {
  const groups = {}
  for (const ind of allPopulation.value) {
    const rk = Math.min(displayRank(ind), 2) + 1
    if (!groups[rk]) groups[rk] = []
    groups[rk].push(ind)
  }
  return groups
})

const sortedRankEntries = computed(() =>
  Object.entries(rankGroup.value)
    .map(([rankKey, list]) => ({
      rankKey,
      level: Number(rankKey) - 1,
      size: list.length,
      list
    }))
    .sort((a, b) => a.level - b.level)
)

const sortedPopulation = computed(() => {
  const groupOrder = new Map(sortedRankEntries.value.map((entry, index) => [entry.rankKey, index]))

  return [...allPopulation.value].sort((a, b) => {
    const rankKeyA = String(Math.min(displayRank(a), 2) + 1)
    const rankKeyB = String(Math.min(displayRank(b), 2) + 1)
    const orderA = groupOrder.get(rankKeyA) ?? Number.MAX_SAFE_INTEGER
    const orderB = groupOrder.get(rankKeyB) ?? Number.MAX_SAFE_INTEGER

    if (orderA !== orderB) return orderA - orderB
    return b.crowdingDistance - a.crowdingDistance
  })
})

function buildObjectiveRanges(individuals) {
  const ranges = {}
  for (const objective of OBJECTIVES) {
    const values = individuals.map(ind => ind.objectives[objective.id])
    ranges[objective.id] = {
      min: Math.min(...values),
      max: Math.max(...values)
    }
  }
  return ranges
}

function getObjectiveUtility(value, objective, ranges) {
  const range = ranges[objective.id]
  if (!range || range.max === range.min) return 1
  if (objective.dir === 'min') {
    return (range.max - value) / (range.max - range.min)
  }
  return (value - range.min) / (range.max - range.min)
}

function selectRecommendedPath(individuals) {
  if (!individuals || individuals.length === 0) return null
  const ranges = buildObjectiveRanges(individuals)
  const weights = activePreference.value.weights
  let best = individuals[0]
  let bestScore = -Infinity

  for (const individual of individuals) {
    let score = 0
    for (const objective of OBJECTIVES) {
      score +=
        getObjectiveUtility(individual.objectives[objective.id], objective, ranges) *
        weights[objective.id]
    }

    const crowdingBonus =
      individual.crowdingDistance >= 1e9 ? 0.03 : Math.min(0.03, individual.crowdingDistance / 100)
    score += crowdingBonus

    if (score > bestScore) {
      bestScore = score
      best = individual
    }
  }

  return best
}

const recommendationTitle = computed(() => `${activePreference.value.label}下的推荐折中方案`)

const recommendationHint = computed(() => {
  if (!selectedPath.value) return '待算法计算完成后生成推荐方案。'
  return `当前推荐结果优先满足“${activePreference.value.label}”偏好，并兼顾 Pareto 前沿分布均衡性。`
})

function pickPlanByScore(individuals, scorer, used = new Set()) {
  const ranked = [...individuals].sort((a, b) => scorer(b) - scorer(a))
  return ranked.find(ind => !used.has(ind)) || ranked[0] || null
}

const representativePlans = computed(() => {
  const source = allPopulation.value.filter(ind => ind.rank === 0)
  const candidates = source.length > 0 ? source : allPopulation.value
  if (candidates.length === 0) return []

  const used = new Set()
  const plans = []
  const recommended = selectRecommendedPath(candidates)
  if (recommended) {
    used.add(recommended)
    plans.push({
      id: 'recommended',
      title: '综合推荐方案',
      description: `根据“${activePreference.value.label}”偏好自动选取的优先方案。`,
      focus: activePreference.value.label,
      individual: recommended
    })
  }

  const efficiency = pickPlanByScore(
    candidates,
    ind =>
      getObjectiveUtility(ind.objectives.t, OBJECTIVES[1], objectiveRanges.value) * 0.65 +
      getObjectiveUtility(ind.objectives.d, OBJECTIVES[0], objectiveRanges.value) * 0.35,
    used
  )
  if (efficiency) {
    used.add(efficiency)
    plans.push({
      id: 'efficiency',
      title: '时效优先方案',
      description: '优先压缩运输时长，并兼顾路径长度控制。',
      focus: '效率突出',
      individual: efficiency
    })
  }

  const safety = pickPlanByScore(
    candidates,
    ind => getObjectiveUtility(ind.objectives.s, OBJECTIVES[3], objectiveRanges.value),
    used
  )
  if (safety) {
    used.add(safety)
    plans.push({
      id: 'safety',
      title: '安全优先方案',
      description: '优先降低危险暴露和极端地形影响，适合风险敏感时段。',
      focus: '安全突出',
      individual: safety
    })
  }

  const heavyLoad = pickPlanByScore(
    candidates,
    ind =>
      getObjectiveUtility(ind.objectives.l, OBJECTIVES[4], objectiveRanges.value) * 0.7 +
      getObjectiveUtility(ind.objectives.f, OBJECTIVES[2], objectiveRanges.value) * 0.3,
    used
  )
  if (heavyLoad) {
    plans.push({
      id: 'heavy-load',
      title: '重载优先方案',
      description: '优先选择更利于满载矿卡稳定通行的路线组合。',
      focus: '重载友好',
      individual: heavyLoad
    })
  }

  return plans
})

function getObjectiveScore(ind, objective) {
  const range = objectiveRanges.value[objective.id]
  if (!range || range.max === range.min) return 0.5
  return getObjectiveUtility(ind.objectives[objective.id], objective, objectiveRanges.value)
}

function getParallelPoints(ind) {
  return parallelAxes.value
    .map(axis => {
      const score = getObjectiveScore(ind, axis)
      const y = parallelPadTop + (1 - score) * (parallelH - parallelPadTop - parallelPadBottom)
      return `${axis.x},${y}`
    })
    .join(' ')
}

function runOptimization() {
  running.value = true
  genProgress.value = 0
  totalGens.value = optimizationConfig.generations
  allPopulation.value = []
  paretoStats.value = null
  selectedPath.value = null

  setTimeout(() => {
    try {
      const result = runNSGA3(optimizationConfig, (gen, population, fronts) => {
        genProgress.value = gen
        if (gen % 5 === 0 || gen === optimizationConfig.generations) {
          const all = []
          for (let fi = 0; fi < fronts.length; fi++) {
            for (const idx of fronts[fi]) {
              all.push({
                waypoints: population[idx].waypoints,
                objectives: population[idx].objectives,
                rank: population[idx].rank,
                crowdingDistance: population[idx].crowdingDistance
              })
            }
          }
          allPopulation.value = all
          const leadingFront = all.filter(ind => ind.rank === 0)
          selectedPath.value = selectRecommendedPath(leadingFront.length > 0 ? leadingFront : all)
        }
      })

      allPopulation.value = result.allIndividuals
      paretoStats.value = result.stats
      selectedPath.value = selectRecommendedPath(
        result.paretoFront.length > 0 ? result.paretoFront : result.allIndividuals
      )
    } catch (e) {
      logger.error('multi-objective-view', 'NSGA-III 计算失败', null, e)
    } finally {
      running.value = false
    }
  }, 50)
}

function selectPath(ind) {
  selectedPath.value = ind
}

function pathPoints(ind) {
  return ind.waypoints.map(p => `${p.x},${p.y}`).join(' ')
}

function getRadarPoints(type) {
  if (!paretoStats.value || !paretoStats.value.objectiveRanges) return ''
  return objectives.value
    .map((obj, i) => {
      const range = paretoStats.value.objectiveRanges[obj.id]
      if (!range) return '70,70'
      let norm
      if (type === 'best') {
        norm = obj.dir === 'max' ? range.max / obj.max : 1 - range.min / obj.max
      } else if (type === 'selected' && selectedPath.value) {
        const v = selectedPath.value.objectives[obj.id]
        norm = obj.dir === 'max' ? v / obj.max : 1 - v / obj.max
      } else {
        norm = obj.dir === 'max' ? range.min / obj.max : 1 - range.max / obj.max
      }
      norm = Math.max(0, Math.min(1, norm))
      const r = 45 * norm
      const angle = ((i * 72 - 90) * Math.PI) / 180
      return `${70 + r * Math.cos(angle)},${70 + r * Math.sin(angle)}`
    })
    .join(' ')
}

function getBestPercent(v, obj) {
  if (!paretoStats.value || !paretoStats.value.objectiveRanges) {
    const norm = obj.dir === 'max' ? v / obj.max : 1 - v / obj.max
    return Math.round(norm * 100)
  }
  const range = paretoStats.value.objectiveRanges[obj.id]
  if (!range || range.max === range.min) return 50
  const norm =
    obj.dir === 'max'
      ? (v - range.min) / (range.max - range.min)
      : 1 - (v - range.min) / (range.max - range.min)
  return Math.round(Math.max(0, Math.min(1, norm)) * 100)
}

function formatValue(v, obj) {
  return Math.round(v) + obj.unit
}

function fmt(v) {
  return v == null ? '-' : Number(v).toFixed(1)
}

onMounted(() => {
  runOptimization()
})
</script>

<style scoped>
.moo-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
}

.control-panel {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  padding: 10px;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 8px;
}

.panel-subtitle {
  font-size: 10px;
  line-height: 1.5;
  color: #8fa2b7;
  margin-bottom: 8px;
}

.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 8px;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-label {
  font-size: 10px;
  color: #8fa2b7;
}

.config-select {
  width: 100%;
}

.config-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.config-tag {
  font-size: 10px;
  color: #b8c5d3;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 999px;
  padding: 2px 8px;
}

.gen-bar {
  height: 3px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}

.gen-fill {
  height: 100%;
  background: linear-gradient(90deg, #67c23a, #409eff);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.legend-bar {
  display: flex;
  gap: 10px;
  padding: 4px 8px;
  font-size: 10px;
  color: #a0aec0;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.legend-line-dot {
  background: repeating-linear-gradient(
    90deg,
    #67c23a 0px,
    #67c23a 3px,
    transparent 3px,
    transparent 5px
  );
}

.stats-panel,
.scatter-panel,
.list-panel,
.detail-panel,
.viz-panel,
.radar-panel,
.experiment-panel,
.parallel-panel,
.recommendation-panel {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  padding: 10px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-top: 6px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
}

.stat-label {
  font-size: 10px;
  font-weight: 500;
}

.stat-range {
  font-size: 10px;
  color: #a0aec0;
}

.stats-extra {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 10px;
  color: #718096;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  font-weight: 500;
  color: #e2e8f0;
  margin-bottom: 8px;
}

.section-note {
  font-size: 9px;
  color: #718096;
  font-weight: 400;
}

.axis-selects {
  display: flex;
  align-items: center;
  gap: 4px;
}

.experiment-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.experiment-card {
  background: rgba(0, 0, 0, 0.18);
  border-radius: 6px;
  padding: 8px;
}

.experiment-title {
  font-size: 11px;
  font-weight: 600;
  color: #d9e4ef;
  margin-bottom: 6px;
}

.experiment-line {
  font-size: 10px;
  color: #9fb0c0;
  line-height: 1.7;
}

.experiment-desc {
  font-size: 10px;
  color: #c0cfdd;
  line-height: 1.6;
  margin-bottom: 6px;
}

.recommendation-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.recommendation-card {
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 8px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    background 0.15s ease;
}

.recommendation-card:hover {
  border-color: rgba(64, 158, 255, 0.45);
  background: rgba(64, 158, 255, 0.08);
}

.recommendation-card-active {
  border-color: rgba(64, 158, 255, 0.7);
  background: rgba(64, 158, 255, 0.12);
}

.recommendation-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.recommendation-title {
  font-size: 11px;
  font-weight: 600;
  color: #e2e8f0;
}

.recommendation-badge {
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 9px;
  font-weight: 600;
  color: #1a1a2e;
}

.recommendation-desc {
  font-size: 10px;
  line-height: 1.5;
  color: #9fb0c0;
  min-height: 30px;
}

.recommendation-metrics {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 9px;
  color: #cbd5e0;
  font-variant-numeric: tabular-nums;
}

.parallel-viz {
  background: rgba(0, 0, 0, 0.22);
  border-radius: 4px;
  padding: 4px 0;
}

.parallel-svg {
  width: 100%;
  height: 170px;
}

.parallel-footer {
  margin-top: 6px;
  font-size: 9px;
  color: #718096;
}

.scatter-viz {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
}

.scatter-svg {
  width: 100%;
  height: 140px;
}

.scatter-info {
  margin-top: 4px;
  font-size: 9px;
  color: #718096;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.path-viz {
  position: relative;
  height: 120px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
}

.path-svg {
  width: 100%;
  height: 100%;
}

.path-info {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(20, 25, 35, 0.95);
  border: 1px solid rgba(103, 194, 58, 0.3);
  border-radius: 4px;
  padding: 6px;
  font-size: 10px;
  color: #e2e8f0;
}

.radar-viz {
  display: flex;
  justify-content: center;
  height: 100px;
}

.radar-svg {
  width: 100px;
  height: 100px;
}

.obj-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.obj-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.obj-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.obj-info span:nth-child(2) {
  color: #a0aec0;
  flex: 1;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.detail-panel {
  border: 1px solid rgba(64, 158, 255, 0.2);
}

.detail-objs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}

.detail-obj-row {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
}

.detail-obj-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.detail-obj-name {
  color: #a0aec0;
  min-width: 32px;
}

.detail-obj-val {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.detail-obj-dir {
  color: #718096;
  font-size: 9px;
}

.detail-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: #a0aec0;
  margin-bottom: 6px;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 8px;
}

.detail-subtitle:first-child {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}

.params-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.param-item {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.param-label {
  font-size: 10px;
  color: #718096;
}

.param-val {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
  font-variant-numeric: tabular-nums;
}

.param-desc {
  font-size: 8px;
  color: #60708a;
}

.waypoints-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.wp-item {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 3px;
  padding: 2px 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}

.wp-item.wp-endpoint {
  background: rgba(64, 158, 255, 0.12);
  border: 1px solid rgba(64, 158, 255, 0.2);
}

.wp-idx {
  color: #718096;
  font-weight: 600;
  min-width: 12px;
}

.wp-coord {
  color: #cbd5e0;
  font-variant-numeric: tabular-nums;
}

.wp-note {
  font-size: 9px;
  color: #60708a;
  font-weight: 400;
  margin-left: 6px;
}

.table-scroll {
  max-height: 320px;
  overflow-y: auto;
  overflow-x: auto;
}

.table-scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.table-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}

.ind-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}

.ind-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.ind-table th {
  background: rgba(0, 0, 0, 0.35);
  padding: 5px 4px;
  text-align: center;
  color: #a0aec0;
  font-weight: 500;
  white-space: nowrap;
}

.th-unit {
  font-size: 8px;
  color: #60708a;
  font-weight: 400;
}

.ind-table td {
  padding: 3px 4px;
  text-align: center;
  color: #cbd5e0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ind-table tbody tr {
  cursor: pointer;
  transition: background 0.15s;
}

.ind-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.05);
}

.ind-table tbody tr.row-sel {
  background: rgba(64, 158, 255, 0.12) !important;
}

.ind-table tbody tr.row-r1 {
  background: rgba(103, 194, 58, 0.04);
}

.col-num {
  width: 22px;
  color: #718096 !important;
}

.col-r {
  width: 26px;
}

.col-cd {
  width: 36px;
  color: #a0aec0;
}

.col-cd.cd-inf {
  color: #67c23a;
  font-weight: 600;
}

.col-obj {
  width: 44px;
}

.col-param {
  width: 44px;
  color: #8e9db0 !important;
}

.rank-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
}

.rank-summary {
  display: flex;
  gap: 10px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.rs-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #a0aec0;
}

.rs-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
}
</style>
