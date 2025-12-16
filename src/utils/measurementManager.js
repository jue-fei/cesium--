import * as Cesium from 'cesium'

export function calculatePolygonArea3D(points) {
    if (!points || points.length < 3) return 0
    let area = 0
    const n = points.length
    const ref = points[0]
    for (let i = 1; i < n - 1; i++) {
        const p1 = points[i]
        const p2 = points[i + 1]
        const v1 = Cesium.Cartesian3.subtract(p1, ref, new Cesium.Cartesian3())
        const v2 = Cesium.Cartesian3.subtract(p2, ref, new Cesium.Cartesian3())
        const cross = Cesium.Cartesian3.cross(v1, v2, new Cesium.Cartesian3())
        area += Cesium.Cartesian3.magnitude(cross) / 2
    }
    return Math.abs(area)
}

export function serializeCartesian(point) {
    if (!point) return null
    return { x: point.x, y: point.y, z: point.z }
}

export function deserializeCartesian(obj) {
    if (!obj) return null
    return new Cesium.Cartesian3(obj.x, obj.y, obj.z)
}
/*
    measurementManager.js
    说明：一个轻量测量管理器，基于 Cesium.ScreenSpaceEventHandler。
    使用方式：
        const mm = new MeasurementManager(viewer);
        // 在回调中更新你的 UI 历史，例如：
        // mm.onHistoryAdd = function(item) { console.log('history item', item); };
        // 或者使用箭头函数： mm.onHistoryAdd = (item) => console.log(item);
        // 启动测量类型示例： mm.start('polyline') 或 mm.start('polygon') 或 mm.start('point')
*/

// 测量类型常量
export const MEASUREMENT_TYPES = {
    POINT: 'point',
    POLYLINE: 'polyline',
    POLYGON: 'polygon'
};

// 单位常量
export const UNIT_TYPES = {
    METER: 'meter',
    KILOMETER: 'kilometer'
};

export default class MeasurementManager {
    // 静态配置
    static DEFAULT_OPTIONS = {
        pointStyle: { pixelSize: 8, color: Cesium.Color.RED, heightReference: Cesium.HeightReference.NONE },
        polylineStyle: { width: 3, material: Cesium.Color.CYAN },
        polygonStyle: {
            material: Cesium.Color.fromCssColorString('rgba(0,150,255,0.2)'),
            outline: true,
            outlineColor: Cesium.Color.BLUE
        },
        labelStyle: {
            font: '12px sans-serif',
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            show: true
        },
        unitType: UNIT_TYPES.METER
    };

    constructor(viewer, options = {}) {
        if (!viewer) throw new Error('viewer is required');

        this.viewer = viewer;
        this.scene = viewer.scene;
        this.handler = null;
        this.currentEntity = null;
        this.currentPositions = [];
        this.isDrawing = false;
        this.isPaused = false;
        this.drawType = null;
        this.onHistoryAdd = null; // callback(item)
        this.onHistoryRemove = null; // callback(item)
        this.history = [];
        this._idCounter = 1;
        this._tempPositions = [];

        // 合并配置
        this.options = { ...MeasurementManager.DEFAULT_OPTIONS, ...options };

        // 从localStorage加载历史记录
        this._loadHistory();
    }

    // 生成唯一ID
    _genId() {
        return `m-${this._idCounter++}`;
    }

    // 开始测量
    start(type = MEASUREMENT_TYPES.POLYLINE) {
        if (this.isDrawing) return;

        this.isDrawing = true;
        this.isPaused = false;
        this.drawType = type;
        this.currentPositions = [];
        this._tempPositions = [];

        // 设置鼠标样式
        this.scene.canvas.style.cursor = 'crosshair';

        if (!this.handler) {
            this.handler = new Cesium.ScreenSpaceEventHandler(this.scene.canvas);
        }

        // 左键添加点
        this.handler.setInputAction(click => {
            if (this.isPaused) return;
            const pos = this.scene.pickPosition(click.position);
            if (!pos) return;
            this._addPoint(pos);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // 鼠标移动更新预览
        this.handler.setInputAction(movement => {
            if (this.isPaused || !this.isDrawing) return;
            const pos = this.scene.pickPosition(movement.endPosition);
            if (!pos) return;
            this._updatePreview(pos);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // 右键：完成绘制
        this.handler.setInputAction(click => {
            if (this.isPaused) return;
            this._finalizeCurrent();
            this._stopInteraction();
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // 中键或ESC键：取消当前绘制
        this.handler.setInputAction(() => {
            this._cancelCurrent();
        }, Cesium.ScreenSpaceEventType.MIDDLE_CLICK);
    }

    // 暂停测量
    pause() {
        if (!this.isDrawing) return;
        this.isPaused = true;
        this.scene.canvas.style.cursor = 'default';
    }

    // 继续测量
    resume() {
        if (!this.isDrawing) return;
        this.isPaused = false;
        this.scene.canvas.style.cursor = 'crosshair';
    }

    // 停止测量
    stop() {
        this._stopInteraction();
        this._cancelCurrent();
    }

    // 添加测量点
    _addPoint(cartesian) {
        this.currentPositions.push(cartesian);

        if (!this.currentEntity) {
            this._createEntity();
        } else if (this.drawType === MEASUREMENT_TYPES.POINT) {
            // 点测量模式下更新位置
            this.currentEntity.position = cartesian;
        }
    }

    // 创建实体
    _createEntity() {
        const id = this._genId();
        const entityOptions = { id };

        switch (this.drawType) {
            case MEASUREMENT_TYPES.POINT:
                entityOptions.position = this.currentPositions[this.currentPositions.length - 1];
                entityOptions.point = this.options.pointStyle;
                entityOptions.label = this.options.labelStyle;
                break;

            case MEASUREMENT_TYPES.POLYGON:
                entityOptions.polygon = {
                    ...this.options.polygonStyle,
                    hierarchy: new Cesium.CallbackProperty(() =>
                        new Cesium.PolygonHierarchy(this._tempPositions.length > 0 ? this._tempPositions : this.currentPositions),
                        false
                    )
                };
                break;

            default: // polyline
                entityOptions.polyline = {
                    ...this.options.polylineStyle,
                    positions: this.currentPositions,
                    // 禁用动态更新以避免Worker错误
                    _dynamicPositions: false
                };
                entityOptions.label = this.options.labelStyle;
        }

        this.currentEntity = this.viewer.entities.add(entityOptions);
    }

    // 更新预览
    _updatePreview(cartesian) {
        if (!this.currentEntity) return;

        // 更新临时位置用于预览
        this._tempPositions = [...this.currentPositions, cartesian];

        // 对于折线，直接更新实体位置以避免Worker错误
        if (this.drawType === MEASUREMENT_TYPES.POLYLINE && this.currentEntity.polyline) {
            this.currentEntity.polyline.positions = this._tempPositions;
        }

        // 计算结果并更新标签
        const result = this._computeResult(this._tempPositions);
        if (this.currentEntity.label) {
            this.currentEntity.label.text = result.displayText;
        }
    }

    // 计算测量结果
    _computeResult(positions) {
        try {
            if (!positions || positions.length === 0) {
                return { type: 'unknown', value: 0, displayText: '' };
            }

            switch (this.drawType) {
                case MEASUREMENT_TYPES.POINT:
                    return this._computePointResult(positions);

                case MEASUREMENT_TYPES.POLYGON:
                    return this._computePolygonResult(positions);

                default: // polyline
                    return this._computePolylineResult(positions);
            }
        } catch (e) {
            console.warn('测量计算错误:', e);
            return { type: 'unknown', value: 0, displayText: '' };
        }
    }

    // 计算点测量结果
    _computePointResult(positions) {
        const cart = positions[positions.length - 1];
        const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(cart);
        const lon = Cesium.Math.toDegrees(carto.longitude).toFixed(6);
        const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(6);
        const height = carto.height.toFixed(2);

        return {
            type: MEASUREMENT_TYPES.POINT,
            value: [lon, lat, height],
            displayText: `(${lon}, ${lat}, ${height}m)`,
            coord: `${lon}, ${lat}, ${height}`
        };
    }

    // 计算线测量结果
    _computePolylineResult(positions) {
        if (positions.length < 2) {
            return { type: MEASUREMENT_TYPES.POLYLINE, value: 0, displayText: '距离: 0 m' };
        }

        let totalDistance = 0;
        for (let i = 1; i < positions.length; i++) {
            // 使用更高效的距离计算方法
            totalDistance += Cesium.Cartesian3.distance(positions[i - 1], positions[i]);
        }

        return {
            type: MEASUREMENT_TYPES.POLYLINE,
            value: totalDistance,
            displayText: this._formatDistance(totalDistance)
        };
    }

    // 计算多边形测量结果
    _computePolygonResult(positions) {
        if (positions.length < 3) {
            return { type: MEASUREMENT_TYPES.POLYGON, value: 0, displayText: '多边形：点不足' };
        }

        // 计算面积
        const area = this._calculatePolygonArea(positions);

        return {
            type: MEASUREMENT_TYPES.POLYGON,
            value: area,
            displayText: this._formatArea(area)
        };
    }

    // 计算多边形面积
    _calculatePolygonArea(positions) {
        if (positions.length < 3) return 0;

        let area = 0;
        const n = positions.length;
        const ref = positions[0];

        for (let i = 1; i < n - 1; i++) {
            const p1 = positions[i];
            const p2 = positions[i + 1];

            // 计算向量叉积
            const v1 = Cesium.Cartesian3.subtract(p1, ref, new Cesium.Cartesian3());
            const v2 = Cesium.Cartesian3.subtract(p2, ref, new Cesium.Cartesian3());
            const cross = Cesium.Cartesian3.cross(v1, v2, new Cesium.Cartesian3());

            // 累加面积
            area += Cesium.Cartesian3.magnitude(cross) / 2;
        }

        return Math.abs(area);
    }

    // 格式化距离显示
    _formatDistance(distance) {
        if (this.options.unitType === UNIT_TYPES.KILOMETER || distance >= 1000) {
            return `距离: ${(distance / 1000).toFixed(3)} km`;
        }
        return `距离: ${distance.toFixed(2)} m`;
    }

    // 格式化面积显示
    _formatArea(area) {
        if (area >= 1000000) {
            return `面积: ${(area / 1000000).toFixed(3)} km²`;
        }
        return `面积: ${area.toFixed(2)} m²`;
    }

    // 完成当前绘制
    _finalizeCurrent() {
        if (!this.currentEntity) return;

        // 确保有足够的点
        if ((this.drawType === MEASUREMENT_TYPES.POLYLINE && this.currentPositions.length < 2) ||
            (this.drawType === MEASUREMENT_TYPES.POLYGON && this.currentPositions.length < 3)) {
            this._cancelCurrent();
            return;
        }

        // 计算最终结果
        const result = this._computeResult(this.currentPositions);

        // 更新实体属性
        this.currentEntity.properties = this.currentEntity.properties || {};
        this.currentEntity.properties.measure = result;
        this.currentEntity.properties.finished = true;

        // 创建历史记录项
        const item = {
            id: this.currentEntity.id || this._genId(),
            type: result.type,
            value: result.value,
            valueText: result.displayText,
            timestamp: new Date().toISOString(),
            entity: this.currentEntity,
            coord: result.coord || '',
            // 存储可序列化的点数据
            points: this.currentPositions.map(p => ({ x: p.x, y: p.y, z: p.z }))
        };

        // 添加到历史记录
        this.history.push(item);

        // 保存到localStorage
        this._saveHistory();

        // 触发回调
        if (typeof this.onHistoryAdd === 'function') {
            this.onHistoryAdd(item);
        }

        // 重置当前状态
        this.currentEntity = null;
        this.currentPositions = [];
        this._tempPositions = [];
    }

    // 取消当前绘制
    _cancelCurrent() {
        if (this.currentEntity) {
            this.viewer.entities.remove(this.currentEntity);
            this.currentEntity = null;
        }

        this.currentPositions = [];
        this._tempPositions = [];
        this._stopInteraction();
    }

    // 停止交互
    _stopInteraction() {
        if (!this.handler) return;

        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.RIGHT_CLICK);
        this.handler.removeInputAction(Cesium.ScreenSpaceEventType.MIDDLE_CLICK);

        this.isDrawing = false;
        this.isPaused = false;
        this.drawType = null;

        // 恢复鼠标样式
        this.scene.canvas.style.cursor = 'default';
    }

    // 删除单个测量记录
    removeById(id) {
        const index = this.history.findIndex(item => item.id === id);
        if (index === -1) return false;

        const item = this.history[index];

        // 从场景中移除实体
        if (item.entity && this.viewer.entities.contains(item.entity)) {
            this.viewer.entities.remove(item.entity);
        }

        // 从历史记录中移除
        this.history.splice(index, 1);

        // 保存到localStorage
        this._saveHistory();

        // 触发回调
        if (typeof this.onHistoryRemove === 'function') {
            this.onHistoryRemove(item);
        }

        return true;
    }

    // 清除所有测量记录
    clearAll() {
        this.history.forEach(item => {
            try {
                if (item.entity && this.viewer.entities.contains(item.entity)) {
                    this.viewer.entities.remove(item.entity);
                }
            } catch (e) {
                console.warn('移除测量实体失败:', e);
            }
        });

        this.history = [];

        // 清除localStorage
        localStorage.removeItem('measurementHistory');

        // 重置ID计数器
        this._idCounter = 1;
    }

    // 设置单位类型
    setUnitType(unitType) {
        if (!Object.values(UNIT_TYPES).includes(unitType)) {
            throw new Error(`无效的单位类型: ${unitType}`);
        }

        this.options.unitType = unitType;

        // 更新所有历史记录的显示文本
        this.history.forEach(item => {
            if (item.entity && item.entity.label) {
                const result = this._computeResult(item.points.map(p => new Cesium.Cartesian3(p.x, p.y, p.z)));
                item.entity.label.text = result.displayText;
                item.valueText = result.displayText;
            }
        });

        // 保存设置
        localStorage.setItem('measurementUnitType', unitType);
    }

    // 从localStorage加载历史记录
    _loadHistory() {
        try {
            // 加载单位设置
            const savedUnitType = localStorage.getItem('measurementUnitType');
            if (savedUnitType && Object.values(UNIT_TYPES).includes(savedUnitType)) {
                this.options.unitType = savedUnitType;
            }

            // 加载历史记录
            const savedHistory = localStorage.getItem('measurementHistory');
            if (savedHistory) {
                const historyData = JSON.parse(savedHistory);
                // 只加载基本数据，实体需要重新创建
                this.history = historyData;
                this._idCounter = Math.max(...this.history.map(item => parseInt(item.id.split('-')[1]) || 0), 0) + 1;
            }
        } catch (e) {
            console.warn('加载测量历史记录失败:', e);
            this.history = [];
        }
    }

    // 保存历史记录到localStorage
    _saveHistory() {
        try {
            // 只保存可序列化的数据
            const serializableHistory = this.history.map(item => ({
                id: item.id,
                type: item.type,
                value: item.value,
                valueText: item.valueText,
                timestamp: item.timestamp,
                coord: item.coord || '',
                points: item.points
            }));

            localStorage.setItem('measurementHistory', JSON.stringify(serializableHistory));
        } catch (e) {
            console.warn('保存测量历史记录失败:', e);
        }
    }

    // 销毁管理器
    destroy() {
        this._stopInteraction();
        if (this.handler) {
            this.handler.destroy();
            this.handler = null;
        }
        this.clearAll();
    }
}
