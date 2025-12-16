// Cesium渲染错误补丁 - 修复extractHeights方法导致的"Cannot read properties of undefined (reading 'height')"错误
import * as Cesium from 'cesium'

/**
 * 补丁函数：修改Cesium的extractHeights方法，避免读取undefined的height属性
 */
export function applyCesiumExtractHeightsPatch() {
    // 检查Cesium是否已加载
    if (typeof Cesium === 'undefined') {
        console.error('Cesium is not loaded, cannot apply patch');
        return;
    }

    // 尝试直接修改worker代码
    if (Cesium.WorkerCache) {
        console.log('Applying Cesium WorkerCache patch...');
        
        // 在创建worker时拦截代码，添加补丁
        const originalCreateWorker = Cesium.WorkerCache.createWorker;
        Cesium.WorkerCache.createWorker = function(workerName, sourceCode) {
            // 检查是否是与几何创建相关的worker
            if (workerName.includes('createGeometry') || workerName.includes('geometry')) {
                // 在sourceCode中添加extractHeights方法的补丁
                const patchedSourceCode = `
                    // Apply extractHeights patch
                    if (typeof extractHeights === 'function') {
                        const originalExtractHeights = extractHeights;
                        extractHeights = function(positions, terrainProvider, offset, count) {
                            try {
                                return originalExtractHeights(positions, terrainProvider, offset, count);
                            } catch (e) {
                                // 捕获"Cannot read properties of undefined (reading 'height')"错误
                                if (e && e.message && e.message.includes('height')) {
                                    console.warn('Caught extractHeights error, returning default heights');
                                    // 返回默认高度数组
                                    const heights = new Float32Array(count);
                                    heights.fill(0);
                                    return heights;
                                }
                                throw e;
                            }
                        };
                    }
                    
                    // Original worker code
                    ${sourceCode}
                `;
                
                return originalCreateWorker.call(this, workerName, patchedSourceCode);
            }
            
            return originalCreateWorker.call(this, workerName, sourceCode);
        };
    }

    // 尝试修改可能的全局函数
    if (typeof window !== 'undefined' && window.Cesium) {
        console.log('Applying global Cesium patch...');
        
        // 尝试访问内部的extractHeights函数
        const maybeExtractHeights = window.Cesium._private?.extractHeights;
        if (typeof maybeExtractHeights === 'function') {
            const originalExtractHeights = maybeExtractHeights;
            window.Cesium._private.extractHeights = function(...args) {
                try {
                    return originalExtractHeights.apply(this, args);
                } catch (e) {
                    if (e && e.message && e.message.includes('height')) {
                        console.warn('Caught global extractHeights error, returning default heights');
                        // 返回默认高度数组
                        const count = args[3] || 1;
                        const heights = new Float32Array(count);
                        heights.fill(0);
                        return heights;
                    }
                    throw e;
                }
            };
        }
    }

    console.log('Cesium extractHeights patch applied');
}

/**
 * 补丁函数：修改折线创建逻辑，避免调用地形高度提取
 */
export function applyCesiumPolylinePatch() {
    if (typeof Cesium === 'undefined') {
        console.error('Cesium is not loaded, cannot apply polyline patch');
        return;
    }

    // 修改PolylineGeometry的createGeometry方法
    if (Cesium.PolylineGeometry && Cesium.PolylineGeometry.createGeometry) {
        const originalCreateGeometry = Cesium.PolylineGeometry.createGeometry;
        Cesium.PolylineGeometry.createGeometry = function(geometry) {
            try {
                // 临时禁用地形高度提取
                const originalExtractHeights = geometry._extractHeights;
                geometry._extractHeights = function(positions, terrainProvider, offset, count) {
                    return new Float32Array(count).fill(0);
                };
                
                const result = originalCreateGeometry.call(this, geometry);
                
                // 恢复原始方法
                geometry._extractHeights = originalExtractHeights;
                
                return result;
            } catch (e) {
                console.warn('Polyline geometry creation failed, returning null');
                return null;
            }
        };
    }

    console.log('Cesium polyline patch applied');
}
