import * as Cesium from 'cesium'
import { ref } from 'vue'

/**
 * 组件视角追随服务（位移跟随实现）
 *
 * - 开启：飞至组件附近，之后相机保持"自由视角"——左键旋转/滚轮缩放/右键平移
 *   全部为 Cesium 原生行为，不受任何变换锁定；
 * - 目标移动（未来的调度车辆动画）：每帧检测包围球中心位移，相机随目标
 *   平移同样的量（不改变视角方向），即"位移跟随"；
 * - 目标未加载：利用数据层的组件世界包围球（model.sphere）先飞往其位置，
 *   轮询等待瓦片加载，feature 注册后自动进入跟随；45s 超时自动解除；
 * - 解除/切换：清理监听（并做一次相机变换重置的兼容性保险）。
 */
export function createCameraFollow(notify) {
  /** 当前追随的组件 featureId（空串 = 未追随），供 UI 高亮按钮状态 */
  const followedId = ref('')

  let activeViewer = null
  let capturedTileset = null
  let tilesetRef = null
  let onPreRender = null
  let onMoveEnd = null
  let mode = '' // '' | 'flying' | 'watching' | 'tracking'
  let targetFeature = null
  let lastCenter = null
  let startTs = 0
  // 追随井下组件时的导航辅助状态快照（解除时精确还原）
  let savedCollision = null
  let savedTranslucency = null

  /**
   * 追随期间的导航辅助（每帧调用）：
   * - 一律解除相机碰撞检测（Cesium 默认把相机钳制在地表之上，
   *   井下追随会被锁死无法拖拽/缩放；地表追随解除也无副作用）；
   * - 相机进入地形内部（低于所在位置的地表高程）时开启地表半透明，
   *   否则旋转拾取不到地表支点 → 拖拽静默失效。
   */
  function updateNavigationAssists(viewer) {
    try {
      const cc = viewer.scene.screenSpaceCameraController
      if (savedCollision === null) {
        savedCollision = cc.enableCollisionDetection
        cc.enableCollisionDetection = false
      }
      const camo = viewer.camera.positionCartographic
      const groundH = camo ? viewer.scene.globe.getHeight(camo) : null
      const under = groundH != null && camo.height < groundH
      const tr = viewer.scene.globe.translucency
      if (under && savedTranslucency === null && !tr.enabled) {
        savedTranslucency = { enabled: tr.enabled, front: tr.frontFaceAlpha }
        tr.enabled = true
        tr.frontFaceAlpha = 0.45
      }
    } catch (_) {
      /* ignore */
    }
  }

  function restoreNavigationAssists() {
    console.warn('[cf] restore: savedCollision=', savedCollision, 'activeViewer=', !!activeViewer)
    if (savedCollision !== null && activeViewer) {
      try {
        activeViewer.scene.screenSpaceCameraController.enableCollisionDetection = savedCollision
      } catch (_) {
        /* ignore */
      }
      savedCollision = null
    }
    if (savedTranslucency && activeViewer) {
      try {
        const tr = activeViewer.scene.globe.translucency
        tr.enabled = savedTranslucency.enabled
        tr.frontFaceAlpha = savedTranslucency.front
      } catch (_) {
        /* ignore */
      }
      savedTranslucency = null
    }
  }

  function resolveBoundingSphere(feature) {
    try {
      // Cesium3DTileFeature → content → tile → boundingSphere（世界坐标）
      const content = feature && feature.content
      const tile = content && (content.tile || content._tile)
      if (tile && tile.boundingSphere) return tile.boundingSphere
    } catch (_) {
      /* stale 引用 */
    }
    return null
  }

  function stopFollow() {
    if (onPreRender && activeViewer) {
      try {
        activeViewer.scene.preRender.removeEventListener(onPreRender)
      } catch (_) {
        /* viewer 可能已销毁 */
      }
    }
    if (onMoveEnd && activeViewer) {
      try {
        activeViewer.camera.moveEnd.removeEventListener(onMoveEnd)
      } catch (_) {
        /* ignore */
      }
    }
    // 兼容性保险：清除任何遗留的相机变换（本服务自身不再设置变换）
    if (activeViewer) {
      try {
        activeViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      } catch (_) {
        /* ignore */
      }
    }
    onPreRender = null
    onMoveEnd = null
    mode = ''
    targetFeature = null
    lastCenter = null
    restoreNavigationAssists()
    activeViewer = null
    tilesetRef = null
    followedId.value = ''
  }

  /** 位移跟随帧循环：目标移动多少，相机跟着平移多少（视角方向保持自由） */
  function makeTrackHandler(viewer, feature) {
    return () => {
      try {
        if (!tilesetRef || tilesetRef.value !== capturedTileset) {
          stopFollow()
          return
        }
        updateNavigationAssists(viewer)
        const cur = resolveBoundingSphere(feature)
        if (!cur) {
          stopFollow()
          return
        }
        if (!lastCenter) {
          lastCenter = cur.center.clone()
          return
        }
        const delta = Cesium.Cartesian3.subtract(
          cur.center,
          lastCenter,
          new Cesium.Cartesian3()
        )
        if (!Cesium.Cartesian3.equals(delta, Cesium.Cartesian3.ZERO)) {
          viewer.camera.position = Cesium.Cartesian3.add(
            viewer.camera.position,
            delta,
            new Cesium.Cartesian3()
          )
          lastCenter = cur.center.clone()
        }
      } catch (_) {
        /* 单帧异常忽略 */
      }
    }
  }

  /** 进入跟随：记录基准中心并挂跟踪帧循环（不设置任何相机变换） */
  function engage(viewer, feature) {
    const bs = resolveBoundingSphere(feature)
    if (!bs) return false
    lastCenter = bs.center.clone()
    // 井下目标：解除碰撞检测 + 地表半透明（拖拽/缩放不再被钳制在地表之上）
    updateNavigationAssists(viewer)
    // 兜底：相机距目标过远说明飞行动画未生效（偶发被取消），直接就位
    let dist = Infinity
    try {
      dist = Cesium.Cartesian3.distance(viewer.camera.positionWC, bs.center)
    } catch (_) {
      /* ignore */
    }
    const range = Math.max(bs.radius * 3, 40)
    if (!Number.isFinite(dist) || dist > range * 4) {
      try {
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(bs.center)
        const dest = Cesium.Matrix4.multiplyByPoint(
          enu,
          new Cesium.Cartesian3(0, -0.62 * range, 0.78 * range),
          new Cesium.Cartesian3()
        )
        viewer.camera.setView({
          destination: dest,
          orientation: { heading: 0, pitch: -0.9, roll: 0 }
        })
      } catch (_) {
        /* ignore */
      }
    }
    mode = 'tracking'
    if (onPreRender && activeViewer) {
      try {
        activeViewer.scene.preRender.removeEventListener(onPreRender)
      } catch (_) {
        /* ignore */
      }
    }
    onPreRender = makeTrackHandler(viewer, feature)
    viewer.scene.preRender.addEventListener(onPreRender)
    if (onMoveEnd && activeViewer) {
      try {
        activeViewer.camera.moveEnd.removeEventListener(onMoveEnd)
      } catch (_) {
        /* ignore */
      }
      onMoveEnd = null
    }
    return true
  }

  /** watching 阶段帧循环：等目标 feature 注册后进入跟随 */
  function makeWatchHandler(featureManager, fid) {
    return () => {
      try {
        if (!tilesetRef || tilesetRef.value !== capturedTileset) {
          stopFollow()
          return
        }
        if (mode !== 'watching') return
        updateNavigationAssists(viewer)
        const f = featureManager.featureMap.get(fid)
        if (!f) {
          if (Date.now() - startTs > 45000) {
            stopFollow()
            if (notify) notify('等待瓦片加载超时，已解除视角追随', 'warning')
          }
          return
        }
        targetFeature = f
        if (!engage(activeViewer, f)) stopFollow()
      } catch (_) {
        /* 单帧异常忽略 */
      }
    }
  }

  function begin(viewer, tsRef, fid, flyFn, featureManager) {
    stopFollow()
    activeViewer = viewer
    tilesetRef = tsRef
    capturedTileset = tsRef ? tsRef.value : null
    followedId.value = fid
    mode = 'flying'
    startTs = Date.now()
    flyFn()
    onMoveEnd = () => {
      if (mode === 'flying') {
        mode = 'watching'
        tryEngage(featureManager, fid)
      }
    }
    viewer.camera.moveEnd.addEventListener(onMoveEnd)
    // moveEnd 兜底（极端情况未触发时）
    setTimeout(() => {
      if (mode === 'flying' && followedId.value === fid) {
        mode = 'watching'
        tryEngage(featureManager, fid)
      }
    }, 2500)
    onPreRender = makeWatchHandler(featureManager, fid)
    viewer.scene.preRender.addEventListener(onPreRender)
    return true
  }

  function tryEngage(featureManager, fid) {
    const f = featureManager && featureManager.featureMap.get(fid)
    if (!f) return false // watching 轮询会继续尝试
    targetFeature = f
    return engage(activeViewer, f)
  }

  /**
   * 切换某组件的追随状态
   * @returns {{following:boolean, ok:boolean, reason?:string}}
   */
  function toggleFollow(viewer, tsRef, model, featureManager) {
    const fid = model.featureId || model.id
    console.warn('[cf] toggleFollow fid=', fid, 'followedId=', followedId.value)
    if (followedId.value === fid) {
      stopFollow()
      return { following: false, ok: true }
    }
    const feature = featureManager && featureManager.featureMap.get(fid)
    if (feature) {
      // 目标已加载：直接飞抵并进入跟随
      const ok = begin(viewer, tsRef, fid, () => {
        const bs = resolveBoundingSphere(feature)
        if (!bs) throw new Error('no bounding sphere')
        viewer.camera.flyToBoundingSphere(bs, {
          duration: 1.2,
          offset: { heading: 0, pitch: -0.9, range: Math.max(bs.radius * 3, 40) }
        })
      }, featureManager)
      if (ok && notify) notify(`视角追随: ${model.name}（视角保持自由，再次点击取消）`, 'info')
      return { following: ok, ok }
    }
    // 目标未加载：用数据层包围球先飞往其位置，等瓦片加载后自动进入跟随
    const sphere = model.sphere
    if (sphere && Number.isFinite(sphere.cx)) {
      const ok = begin(viewer, tsRef, fid, () => {
        const center = new Cesium.Cartesian3(sphere.cx, sphere.cy, sphere.cz)
        // 飞行前即解除地表钳制（井下目标）
        updateNavigationAssists(viewer)
        viewer.camera.flyToBoundingSphere(
          { center, radius: Math.max(sphere.r, 5) },
          {
            duration: 1.6,
            offset: { heading: 0, pitch: -0.9, range: Math.max(sphere.r * 3, 30) }
          }
        )
      }, featureManager)
      if (ok && notify) notify(`已飞往 ${model.name} 位置，等待瓦片加载后自动锁定追随`, 'info')
      return { following: ok, ok }
    }
    return { following: false, ok: false, reason: '该组件没有对应瓦片，无法追随' }
  }

  return { followedId, toggleFollow, stopFollow }
}
