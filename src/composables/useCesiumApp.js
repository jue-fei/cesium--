import { onMounted, ref, onUnmounted, reactive } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { initViewer, destroyViewer, resetViewToModel, getViewer } from '../utils/viewerManager.js'
import { load3DModel, updateModelPosition as updateModelPos, updateModelTransform as updateModelTrans, resetModel as resetModelFunc, getModelInstance } from '../utils/modelManager.js'
import { calculatePolygonArea3D, serializeCartesian } from '../utils/measurementManager.js'
import { exportSceneData as exportSceneDataUtil, exportReport as exportReportUtil, exportScreenshot as exportScreenshotUtil } from '../utils/exportManager.js'
import { FeatureManager } from '../utils/featureManager.js'
import { GeologyManager, geologyAnalysisUtils, geologyExportUtils } from '../utils/geologyManager.js'

export default function useCesiumApp() {
    // ===== Cesium Initialization =====
    if (typeof window !== 'undefined') {
        window.CESIUM_BASE_URL = "/"
        Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyYjQwMDhkNy04NjljLTRkZGQtYTI4MS0yYTA4ZGQ4NTczYTEiLCJpZCI6MzE2NzQ2LCJpYXQiOjE3NTEyMDQ1MzV9.CZ2M4g2o2JGRE7OFtHVmXuJ_A-XMx59BgOqjqbIz9xQ"
    }

    // ===== State Management =====
    // UI States
    const isCollapsed = ref(false)
    const activeTab = ref('geology')
    const modelConfigFiles = ref([
        { name: 'demo1 配置', path: './3d/demo1/feature.json' },
        { name: 'demo2 配置', path: './3d/demo2/features.json' },
        { name: 'demo3 配置', path: './3d/demo3/feature.json' },
        { name: 'demo4 配置', path: './3d/demo4/feature.json' }
    ])
    const currentConfigFile = ref('')
    const modelList = ref([])
    const operationMessage = ref('')
    const operationMessageType = ref('success')
    const showMessage = ref(false)
    const globalOpacity = ref(0)
    const coordinateSystem = ref('wgs84')
    const modelPosition = ref({ longitude: 113.323, latitude: 23.106, height: 50 })
    const modelTransform = ref({ rotationX: 15, rotationY: 0, rotationZ: 0 })
    const modelLoadStatus = ref(null)
    const loading = ref(false)
    const selectedModel = ref(null)
    const displayedModelInfo = ref(null) // 用于存储当前显示的模型信息

    // 同步selectedModel和displayedModelInfo
    const syncModelInfo = (model) => {
        selectedModel.value = model
        displayedModelInfo.value = model
    }

    // Measurement States
    const isMeasuring = ref(false)
    const isAreaMeasuring = ref(false)
    const measurementPoints = ref([])
    const measurementDistance = ref(0)
    const measurementArea = ref(0)
    const measurementEntities = ref([])
    const measurementHistory = ref([])

    // Section Cutting States
    const isSectionEnabled = ref(false)
    const sectionDirection = ref('x')
    const sectionPosition = ref(0)
    const sectionThickness = ref(1)
    const showSectionPlane = ref(true)
    const sectionPlaneColor = ref('#ff6600')
    const sectionPlaneOpacity = ref(50)
    const sectionRange = ref({ min: -100, max: 100, step: 1 })
    const isMultipleSectionsEnabled = ref(false)
    const displayQuality = ref('medium')
    const terrainQuality = ref('medium')
    let sectionPlaneEntity = null

    // Internal References
    const viewerRef = ref(null)
    let viewer = null
    let tileset = null
    let modelClickHandler = null
    let featureManager = new FeatureManager()
    let geologyManager = null
    let measurementHandler = null
    let areaMeasurementHandler = null
    let currentTimeElement = null

    // ===== Helper Functions =====
    /**
     * Show operation message with type and auto-hide after 3 seconds
     * @param {string} message - Operation message content
     * @param {string} type - Message type: success, info, warning, error
     */
    function showOperationMessage(message, type = 'success') {
        operationMessage.value = message
        operationMessageType.value = type
        showMessage.value = true

        // 根据消息类型设置不同的显示时间
        let displayTime = 3000
        if (type === 'error') displayTime = 5000
        if (type === 'success') displayTime = 4000

        setTimeout(() => { showMessage.value = false }, displayTime)
    }

    /**
     * Toggle sidebar collapse state
     */
    const toggleCollapse = () => isCollapsed.value = !isCollapsed.value

    /**
     * Update current time display
     */
    function updateTime() {
        if (!currentTimeElement) {
            currentTimeElement = document.getElementById('current-time')
            if (!currentTimeElement) return
        }
        currentTimeElement.textContent = new Date().toLocaleString()
    }

    /**
     * Reset cursor to default
     */
    const resetCursor = () => {
        if (viewer && viewer.canvas) {
            viewer.canvas.style.cursor = 'default'
        }
    }

    /**
     * Configure scene lighting for better visualization
     */
    const configureSceneLighting = () => {
        if (!viewer) return

        // Disable advanced lighting features to prevent yellow tint
        viewer.scene.globe.enableLighting = false
        viewer.scene.globe.dynamicAtmosphereLighting = false
        viewer.scene.globe.dynamicAtmosphereLightingFromSun = false
    }

    // ===== Model Configuration and Initialization =====
    /**
     * Handle configuration file change
     * @param {string} configFilePath - Path to the configuration file
     */
    const onConfigChange = async (configFilePath) => {
        if (configFilePath) currentConfigFile.value = configFilePath
        if (!currentConfigFile.value) return

        try {
            // Determine model path based on config file
            const demoMatch = currentConfigFile.value.match(/demo(\d+)/i)
            const demoNumber = demoMatch ? demoMatch[1] : '4' // Default to demo4 if no match found
            const modelPath = `./3d/demo${demoNumber}/tileset.json`

            // Try different feature file naming patterns
            const featurePathVariations = [
                currentConfigFile.value, // Use the selected config file path first
                `./3d/demo${demoNumber}/feature.json`,
                `./3d/demo${demoNumber}/features.json`
            ]

            // Save current model position, transform, and camera view before loading new model
            const savedPosition = { ...modelPosition.value }
            const savedTransform = { ...modelTransform.value }

            // Save camera position and orientation
            let savedCameraPosition = null
            let savedCameraDirection = null
            let savedCameraUp = null
            if (viewer) {
                savedCameraPosition = viewer.camera.position.clone()
                savedCameraDirection = viewer.camera.direction.clone()
                savedCameraUp = viewer.camera.up.clone()
            }

            // Reset state before loading new model
            modelList.value = []
            selectedModel.value = null
            featureManager.resetState()

            // Load feature configuration for model mappings (try multiple file paths)
            let featureData = null
            let foundFeaturePath = null

            for (const featurePath of featurePathVariations) {
                try {
                    const featureResponse = await fetch(featurePath)
                    if (featureResponse.ok) {
                        featureData = await featureResponse.json()
                        foundFeaturePath = featurePath
                        console.debug(`成功加载特征配置文件: ${featurePath}`)
                        break
                    }
                } catch (e) {
                    console.debug(`特征文件未找到: ${featurePath}`)
                }
            }

            if (!featureData) {
                console.warn('未找到特征配置文件，将使用默认模型列表')
            }

            // Load new model
            const result = await load3DModel([modelPath])
            tileset = getModelInstance()
            modelLoadStatus.value = result

            if (tileset) {
                const processModel = () => {
                    // 确保特征管理器使用新的tileset
                    featureManager.setTileset(tileset)
                    featureManager.resetState()

                    // 先扫描特征，再初始化模型列表
                    scanAndStoreFeatures()

                    // Use feature data if available, otherwise use default
                    if (featureData && featureData.modelMappings) {
                        initializeModelList(featureData)
                    } else {
                        // 等待特征扫描完成后再初始化默认模型列表
                        setTimeout(() => {
                            initializeDefaultModelList()
                        }, 100)
                    }

                    // Apply saved position and transform to the new model
                    updateModelPos(savedPosition)
                    updateModelTrans(savedTransform, savedPosition)

                    // Update the reactive variables to reflect the saved state
                    modelPosition.value = { ...savedPosition }
                    modelTransform.value = { ...savedTransform }

                    // Restore camera position and orientation if saved
                    if (viewer && savedCameraPosition && savedCameraDirection && savedCameraUp) {
                        viewer.camera.setView({
                            destination: savedCameraPosition,
                            orientation: {
                                direction: savedCameraDirection,
                                up: savedCameraUp
                            }
                        })
                    }

                    console.debug(`成功加载配置文件: ${currentConfigFile.value}`)
                    console.debug(`特征数量: ${featureManager.getFeatureCount()}`)
                    console.debug(`模型列表数量: ${modelList.value.length}`)
                }

                const handleLoadError = (err) => {
                    console.error('3D Tiles加载失败:', err)
                    initializeDefaultModelList()
                }

                if (tileset.readyPromise) {
                    tileset.readyPromise.then(processModel).catch(handleLoadError)
                } else {
                    // If no readyPromise, process immediately
                    processModel()
                }
            }
        } catch (error) {
            console.error('Failed to load configuration file:', error)
            initializeDefaultModelList()
        }
    }

    /**
     * Load model properties from various candidate paths
     */
    const loadModelProperties = async () => {
        const candidates = []

        // Try to infer from current config file
        if (currentConfigFile?.value) {
            try {
                const inferred = currentConfigFile.value.replace(/tileset\.json$/i, 'feature.json')
                candidates.push(inferred)
            } catch (e) {
                console.warn('Failed to infer feature file path from config:', e)
            }
        }

        // Add default path (most common case)
        candidates.push('./3d/demo4/feature.json')

        let lastError = null
        for (const path of candidates) {
            try {
                const response = await fetch(path)
                if (!response.ok) {
                    // Only log 404 errors as warnings, not as errors
                    if (response.status === 404) {
                        console.warn(`Feature file not found at ${path} (HTTP ${response.status})`)
                    } else {
                        lastError = new Error(`HTTP ${response.status}: ${response.statusText} when fetching ${path}`)
                    }
                    continue
                }

                const propertiesData = await response.json()
                initializeModelList(propertiesData)
                showOperationMessage(`成功加载 ${modelList.value.length} 个模型的属性 (从 ${path})`, 'success')
                return
            } catch (error) {
                lastError = error
                console.warn(`从 ${path} 加载模型属性失败:`, error)
            }
        }

        // All attempts failed - only log warning, not error
        console.warn('Failed to load model properties file, tried paths:', candidates)

        // Ensure features are scanned before fallback
        if (featureManager.getFeatureCount() === 0 && tileset) {
            scanAndStoreFeatures()
        }

        // Fallback to default model list immediately
        initializeDefaultModelList()
        showOperationMessage('No model properties file found, using default model configuration', 'warning')
    }

    /**
     * Initialize model list from properties data
     * @param {Object} propertiesData - Properties data from JSON file
     */
    const initializeModelList = (propertiesData) => {
        if (propertiesData.modelMappings && Array.isArray(propertiesData.modelMappings)) {
            // 先清空现有模型列表
            modelList.value = []

            // 创建新的模型列表
            modelList.value = propertiesData.modelMappings.map(model => reactive({
                ...model,
                visible: true,
                opacity: 0,
                geologyProperties: model.geologyProperties || {},
                miningProperties: model.miningProperties || {},
                safetyProperties: model.safetyProperties || {}
            }))

            // 确保特征扫描在模型列表创建后执行
            setTimeout(() => {
                scanAndStoreFeatures()
                showOperationMessage(`成功加载 ${modelList.value.length} 个模型的配置`, 'success')
                console.debug('模型列表已更新:', modelList.value.map(m => ({ id: m.id, name: m.name })))
            }, 0)
        } else {
            if (featureManager.getFeatureCount() === 0 && tileset) {
                scanAndStoreFeatures()
            }

            // 使用基于实际特征的默认模型列表
            initializeDefaultModelList()
            showOperationMessage('配置文件格式不正确，使用默认配置', 'warning')
        }
    }

    /**
     * Scan and store features from tileset
     */
    const scanAndStoreFeatures = () => {
        if (tileset && featureManager.getFeatureCount() === 0) {
            console.debug('Scanning and storing features from tileset...')
            featureManager.setTileset(tileset)
            featureManager.scanAndStoreFeatures()
            console.debug('Feature scan completed')
            console.debug('Model list IDs:', modelList.value.map(model => model.id))
        } else {
            console.debug('Tileset not available or features already stored')
        }
    }

    /**
     * Initialize default model list when no configuration is found
     */
    const initializeDefaultModelList = () => {
        modelList.value = []
        const totalFeatures = featureManager.getFeatureCount()
        if (totalFeatures === 0) {
            console.warn('No features available to create default model list')
            return
        }
        const featureIds = featureManager.getAllFeatureIds()

        // Model classification rules
        const modelClassifications = [
            { keywords: ['surface', '地表'], type: 'surface', category: '地形地貌', geologyType: '地表层' },
            { keywords: ['terrain', '地形'], type: 'terrain', category: '地形地貌', geologyType: '地形模型' },
            { keywords: ['pit', '采场'], type: 'mining_pit', category: '采矿工程', geologyType: '露天采场' },
            { keywords: ['ore', '矿体'], type: 'ore_body', category: '矿产资源', geologyType: '矿体' },
            { keywords: ['waste', '废石'], type: 'waste_body', category: '矿产资源', geologyType: '废石' }
        ]

        // Create model entries from feature IDs
        featureIds.forEach((featureId) => {
            let featureName = 'Unknown Model'

            // Try to get feature name from properties
            try {
                const feature = featureManager.featureMap.get(featureId)
                if (feature && typeof feature.getProperty === 'function') {
                    featureName = feature.getProperty('name') || feature.getProperty('Name') || feature.getProperty('description') || featureName
                }
            } catch (e) {
                console.warn(`Failed to get property for feature ${featureId}:`, e)
            }

            // Create base model object
            const model = reactive({
                id: featureId,
                name: featureName,
                type: 'unknown',
                category: 'Unknown',
                visible: true,
                opacity: 0,
                geologyProperties: { '地质类型': 'Unknown', 'ID': featureId }
            })

            // Classify model based on ID and name
            const idLower = featureId.toLowerCase()
            const nameLower = featureName.toLowerCase()

            for (const classification of modelClassifications) {
                const matchesId = classification.keywords.some(keyword => idLower.includes(keyword))
                const matchesName = classification.keywords.some(keyword => nameLower.includes(keyword))

                if (matchesId || matchesName) {
                    model.type = classification.type
                    model.category = classification.category
                    model.geologyProperties['地质类型'] = classification.geologyType
                    break
                }
            }

            modelList.value.push(model)
        })

        // 如果没有特征数据，显示警告信息
        if (modelList.value.length === 0) {
            console.warn('没有找到可用的特征数据来创建模型列表')
            showOperationMessage('未找到模型特征数据，请检查模型文件', 'warning')
        } else {
            console.debug('基于特征数据生成的模型列表:', modelList.value.map(m => ({ id: m.id, name: m.name })))
            showOperationMessage(`基于特征数据生成了 ${modelList.value.length} 个模型`, 'success')
        }
    }

    // ===== Model Interaction and Management =====
    /**
     * Initialize model click event handler
     */
    function initModelEventHandler() {
        if (!viewer) return

        modelClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
        modelClickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }

    /**
     * Handle left click on model
     * @param {Object} click - Click event object
     */
    function onLeftClick(click) {
        if (!tileset) return
        const pickedFeature = viewer.scene.pick(click.position)
        if (!Cesium.defined(pickedFeature)) return

        if (pickedFeature.primitive === tileset && pickedFeature instanceof Cesium.Cesium3DTileFeature) {
            handleModelSelection(pickedFeature)
        }
    }

    /**
    * Handle model selection
    * @param {Object} feature - Selected 3D tile feature
    */
    function handleModelSelection(feature) {
        const featureId = featureManager.getFeatureId(feature)

        if (!featureId) {
            console.warn('Failed to get feature ID from selected feature')
            showOperationMessage('无法获取模型特征ID', 'error')
            return
        }

        const model = modelList.value.find(m => m.id === featureId)

        if (model) {
            syncModelInfo(model)
            highlightModel(model)

            // 创建详细的模型信息提示
            const modelInfo = `
                <div style="text-align: left; padding: 10px;">
                    <h4 style="margin: 0 0 8px 0; color: #4e7ddb;">模型选择信息</h4>
                    <p style="margin: 4px 0;"><strong>模型名称:</strong> ${model.name}</p>
                    <p style="margin: 4px 0;"><strong>模型ID:</strong> ${model.id}</p>
                    <p style="margin: 4px 0;"><strong>类型:</strong> ${model.type}</p>
                    <p style="margin: 4px 0;"><strong>分类:</strong> ${model.category}</p>
                    <p style="margin: 4px 0;"><strong>可见性:</strong> ${model.visible ? '可见' : '隐藏'}</p>
                    <p style="margin: 4px 0;"><strong>透明度:</strong> ${model.opacity}%</p>
                </div>
            `

            // 显示更详细的提示信息
            showOperationMessage(`已选中模型: ${model.name} (ID: ${model.id})`, 'success')
        } else {
            // Create temporary model for unknown features
            const tempModel = reactive({
                id: featureId,
                name: `未分类模型 (${featureId})`,
                type: 'unknown',
                category: 'Unknown',
                visible: true,
                opacity: 0,
                geologyProperties: { '地质类型': 'Unknown', 'ID': featureId }
            })
            syncModelInfo(tempModel)
            highlightModel(tempModel)
            showOperationMessage(`选中未知模型: ${featureId}`, 'info')
        }
    }

    /**
     * Toggle model visibility
     * @param {Object} model - Model object
     */
    const toggleModelVisibility = (model) => {
        if (!tileset) {
            console.warn('Cannot toggle model visibility: tileset not initialized')
            return
        }

        // model.visible is already updated by v-model
        const result = featureManager.toggleModelVisibility(model)
        if (result.success) {
            showOperationMessage(result.message, 'success')
        } else {
            showOperationMessage(result.message, 'warning')
        }
    }

    /**
     * Highlight selected model
     * @param {Object} model - Model object to highlight
     */
    const highlightModel = (model) => {
        featureManager.highlightModel(model)
    }

    /**
     * Update model opacity
     * @param {Object} model - Model object
     */
    const updateModelOpacity = (model) => {
        if (!tileset) {
            console.warn('Cannot update model opacity: tileset not initialized')
            return
        }

        const result = featureManager.updateModelOpacity(model, globalOpacity.value)
        if (result.success) {
            showOperationMessage(result.message, 'success')
        } else {
            showOperationMessage(result.message, 'warning')
        }
    }

    /**
     * Update global opacity for all models
     * @param {number} newOpacity - New opacity value (0-100)
     */
    const updateGlobalOpacity = (newOpacity) => {
        globalOpacity.value = newOpacity
        modelList.value.forEach(model => {
            updateModelOpacity(model)
        })
        showOperationMessage(`Global opacity updated to ${newOpacity}%`, 'success')
    }

    /**
     * Reset opacity for all models
     */
    const resetAllOpacity = () => {
        modelList.value.forEach(m => m.opacity = 0)
        globalOpacity.value = 0
        const result = featureManager.resetAllOpacity(modelList.value, globalOpacity.value)
        if (result.success) {
            console.log(result.message)
        }
    }

    /**
     * Show all models
     */
    const showAllModels = () => {
        featureManager.showAllModels(modelList.value)
        console.log('All models shown')
    }

    /**
     * Hide all models
     */
    const hideAllModels = () => {
        featureManager.hideAllModels(modelList.value)
        console.log('All models hidden')
    }

    // ===== Measurement Functions =====
    /**
     * Toggle distance measurement
     */
    const toggleMeasurement = () => {
        if (isMeasuring.value) {
            stopMeasurement()
        } else {
            stopAreaMeasurement()
            startDistanceMeasurement()
        }
    }

    /**
     * Toggle area measurement
     */
    const toggleAreaMeasurement = () => {
        if (isAreaMeasuring.value) {
            stopAreaMeasurement()
        } else {
            stopMeasurement()
            startAreaMeasurement()
        }
    }

    /**
     * Start distance measurement
     */
    const startDistanceMeasurement = () => {
        clearCurrentMeasurement()
        isMeasuring.value = true
        if (!viewer) return

        viewer.canvas.style.cursor = 'crosshair'
        measurementHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

        // Add measurement point on left click
        measurementHandler.setInputAction((evt) => {
            const pos = getPositionFromClick(evt.position)
            if (!pos) return
            addMeasurementPoint(pos)
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

        // Save measurement and stop on right click
        measurementHandler.setInputAction((evt) => {
            if (measurementPoints.value.length >= 2) {
                saveMeasurementToHistory('distance')
            }
            stopMeasurement()
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

        // Update temporary line on mouse move
        measurementHandler.setInputAction((evt) => {
            if (measurementPoints.value.length > 0) {
                updateTemporaryLine(evt.endPosition)
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    }

    /**
     * Stop distance measurement
     */
    const stopMeasurement = () => {
        if (measurementHandler) {
            measurementHandler.destroy()
            measurementHandler = null
        }
        resetCursor()
        isMeasuring.value = false

        // Remove temporary line
        const temp = viewer.entities.getById('measurement-temp-line')
        if (temp) viewer.entities.remove(temp)
    }

    /**
     * Start area measurement
     */
    const startAreaMeasurement = () => {
        clearCurrentMeasurement()
        isAreaMeasuring.value = true
        if (!viewer) return

        viewer.canvas.style.cursor = 'crosshair'
        areaMeasurementHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

        // Add measurement point on left click
        areaMeasurementHandler.setInputAction((evt) => {
            const pos = getPositionFromClick(evt.position)
            if (!pos) return
            addMeasurementPoint(pos)
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

        // Save measurement and stop on right click
        areaMeasurementHandler.setInputAction((evt) => {
            if (measurementPoints.value.length >= 3) {
                saveMeasurementToHistory('area')
            }
            stopAreaMeasurement()
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

        // Update temporary line on mouse move
        areaMeasurementHandler.setInputAction((evt) => {
            if (measurementPoints.value.length > 0) {
                updateTemporaryLine(evt.endPosition)
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    }

    /**
     * Stop area measurement
     */
    const stopAreaMeasurement = () => {
        if (areaMeasurementHandler) {
            areaMeasurementHandler.destroy()
            areaMeasurementHandler = null
        }
        resetCursor()
        isAreaMeasuring.value = false

        // Remove temporary line
        const temp = viewer.entities.getById('measurement-temp-line')
        if (temp) viewer.entities.remove(temp)

        // Draw area polygon if enough points
        if (measurementPoints.value.length >= 3) {
            drawAreaPolygon()
        }
    }

    /**
     * Clear current measurement
     */
    const clearCurrentMeasurement = () => {
        resetCursor()

        // Remove all measurement entities
        measurementEntities.value.forEach(e => viewer.entities.remove(e))
        measurementEntities.value = []

        // Remove temporary line
        const temp = viewer.entities.getById('measurement-temp-line')
        if (temp) viewer.entities.remove(temp)

        // Reset measurement states
        measurementPoints.value = []
        measurementDistance.value = 0
        measurementArea.value = 0

        if (isMeasuring.value) stopMeasurement()
        if (isAreaMeasuring.value) stopAreaMeasurement()
    }

    /**
     * Clear all measurements and history
     */
    const clearAllMeasurements = () => {
        clearCurrentMeasurement()
        clearMeasurementHistory()
    }

    /**
     * Get position from click event
     * @param {Object} screenPosition - Screen position from click event
     * @returns {Object|null} - Cartesian position or null if not found
     */
    const getPositionFromClick = (screenPosition) => {
        if (!viewer) return null

        try {
            // Try to pick from 3D tiles or entities first
            const picked = viewer.scene.pick(screenPosition)
            if (picked && (picked.primitive instanceof Cesium.Cesium3DTileset || picked.id)) {
                const pos = viewer.scene.pickPosition(screenPosition)
                if (pos && Cesium.Cartesian3.distance(pos, Cesium.Cartesian3.ZERO) > 0) return pos
            }

            // Try to pick from terrain
            const ray = viewer.camera.getPickRay(screenPosition)
            const terrainPos = viewer.scene.globe.pick(ray, viewer.scene)
            if (terrainPos) return terrainPos

            // Fallback to ellipsoid
            return viewer.scene.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid)
        } catch (e) {
            return null
        }
    }

    /**
     * Add measurement point
     * @param {Object} position - Cartesian position
     */
    const addMeasurementPoint = (position) => {
        measurementPoints.value.push(position)

        // Add point entity
        const pointEntity = viewer.entities.add({
            position,
            point: { pixelSize: 6, color: Cesium.Color.YELLOW }
        })
        measurementEntities.value.push(pointEntity)

        // Calculate distance if enough points
        if (measurementPoints.value.length >= 2) {
            const a = measurementPoints.value[measurementPoints.value.length - 2]
            const b = measurementPoints.value[measurementPoints.value.length - 1]
            const distance = Cesium.Cartesian3.distance(a, b)
            measurementDistance.value += distance

            // Add line entity
            const line = viewer.entities.add({
                polyline: { positions: [a, b], width: 2, material: Cesium.Color.CYAN }
            })
            measurementEntities.value.push(line)
        }
    }

    /**
     * Update temporary measurement line
     * @param {Object} screenPosition - Current mouse position
     */
    const updateTemporaryLine = (screenPosition) => {
        const pos = getPositionFromClick(screenPosition)
        if (!pos || measurementPoints.value.length === 0) return

        const last = measurementPoints.value[measurementPoints.value.length - 1]

        // Remove existing temporary line
        const temp = viewer.entities.getById('measurement-temp-line')
        if (temp) viewer.entities.remove(temp)

        // Add new temporary line
        viewer.entities.add({
            id: 'measurement-temp-line',
            polyline: {
                positions: [last, pos],
                width: 1,
                material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE })
            }
        })
    }

    /**
     * Draw area polygon
     */
    const drawAreaPolygon = () => {
        if (measurementPoints.value.length < 3) return

        // Close the polygon
        const pts = [...measurementPoints.value, measurementPoints.value[0]]

        // Add polygon entity
        const poly = viewer.entities.add({
            polygon: { hierarchy: pts, material: Cesium.Color.GREEN.withAlpha(0.2) }
        })
        measurementEntities.value.push(poly)

        // Calculate area
        const area = calculatePolygonArea3D(pts)
        measurementArea.value = area
    }

    /**
     * Save measurement to history
     * @param {string} type - Measurement type: distance or area
     */
    const saveMeasurementToHistory = (type) => {
        // Check if measurement has valid value
        if ((type === 'distance' && measurementDistance.value === 0) ||
            (type === 'area' && measurementArea.value === 0)) {
            return
        }

        // Create serializable record
        const serializablePoints = measurementPoints.value.map(p => serializeCartesian(p))
        const record = {
            id: Date.now(),
            type,
            distance: measurementDistance.value,
            area: measurementArea.value,
            points: serializablePoints,
            timestamp: Date.now()
        }

        // Add to history and save to localStorage
        measurementHistory.value.unshift(record)
        const toSave = measurementHistory.value.map(r => ({
            id: r.id,
            type: r.type,
            distance: r.distance,
            area: r.area,
            points: r.points,
            timestamp: r.timestamp
        }))

        localStorage.setItem('measurementHistory', JSON.stringify(toSave))
    }

    /**
     * Load measurement history from localStorage
     */
    const loadMeasurementHistory = () => {
        const stored = localStorage.getItem('measurementHistory')
        if (stored) {
            try {
                measurementHistory.value = JSON.parse(stored)
            } catch (e) {
                measurementHistory.value = []
            }
        }
    }

    /**
     * Clear measurement history
     */
    const clearMeasurementHistory = () => {
        measurementHistory.value = []
        localStorage.removeItem('measurementHistory')
    }

    /**
     * Delete specific measurement record
     * @param {number} id - Record ID to delete
     */
    const deleteMeasurementRecord = (id) => {
        measurementHistory.value = measurementHistory.value.filter(r => r.id !== id)
        localStorage.setItem('measurementHistory', JSON.stringify(measurementHistory.value))
    }

    // ===== Geology Analysis Functions =====
    /**
     * Initialize borehole data
     */
    const initBoreholes = (boreholeData) => {
        return geologyManager ? geologyManager.initBoreholes(boreholeData) : []
    }

    /**
     * Show borehole details
     */
    const showBoreholeDetails = (boreholeId) => {
        return geologyManager ? geologyManager.showBoreholeDetails(boreholeId) : null
    }

    /**
     * Create geological section
     */
    const createGeologicalSection = (sectionPoints, stratigraphyData) => {
        return geologyManager ? geologyManager.createGeologicalSection(sectionPoints, stratigraphyData) : null
    }

    /**
     * Calculate ore reserve
     */
    const calculateOreReserve = (orebody, density) => {
        return geologyManager ? geologyManager.calculateOreReserve(orebody, density) : null
    }

    /**
     * Generate geology report
     */
    const generateGeologyReport = (options) => {
        return geologyManager ? geologyManager.generateGeologyReport(options) : null
    }

    /**
     * Export boreholes data
     */
    const exportBoreholesToJSON = (boreholes) => {
        return geologyExportUtils.exportBoreholesToJSON(boreholes)
    }

    /**
     * Export boreholes data (alias)
     */
    const exportBoreholeData = exportBoreholesToJSON

    /**
     * Export geology report
     */
    const exportGeologyReport = (report) => {
        return geologyExportUtils.exportGeologyReport(report)
    }

    /**
     * Calculate stratigraphy statistics
     */
    const calculateStratigraphyStats = (boreholes) => {
        return geologyAnalysisUtils.calculateStratigraphyStats(boreholes)
    }

    // ===== Export and Scene Management =====
    /**
     * Export scene data
     */
    const exportSceneData = () => exportSceneDataUtil(modelList.value, measurementHistory.value, coordinateSystem.value)

    /**
     * Export report
     */
    const exportReport = () => exportReportUtil(modelList.value, measurementHistory.value, coordinateSystem.value)

    /**
     * Export screenshot
     */
    const exportScreenshot = () => exportScreenshotUtil(viewer)

    /**
     * Fit view to models
     */
    const fitToModels = () => { if (viewer && tileset) viewer.zoomTo(tileset) }

    /**
     * Toggle fullscreen
     */
    const toggleFullscreen = () => {
        if (!viewer) return
        // 使用浏览器原生的全屏 API
        if (!document.fullscreenElement) {
            const container = document.getElementById('cesiumContainer')
            if (container && container.requestFullscreen) {
                container.requestFullscreen().catch(err => {
                    console.warn('无法进入全屏模式:', err)
                })
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen()
            }
        }
    }

    // ===== View and Model Control =====
    /**
     * Update model position
     * @param {Object} newPosition - New position object
     */
    const updateModelPosition = (newPosition) => {
        modelPosition.value = { ...modelPosition.value, ...newPosition }
        updateModelPos(modelPosition.value)
    }

    /**
     * Update model transform
     * @param {Object} newTransform - New transform object
     */
    const updateModelTransform = (newTransform) => {
        modelTransform.value = { ...modelTransform.value, ...newTransform }
        updateModelTrans(newTransform)
    }

    /**
     * Reset view to model
     */
    const resetView = async () => {
        const t = getModelInstance()
        if (t) await resetViewToModel(t)
    }

    /**
     * Reset model position and transform
     */
    const resetModel = () => {
        const result = resetModelFunc()
        if (result) {
            modelPosition.value = result.position
            modelTransform.value = result.transform
        }
    }

    // ===== Lifecycle =====
    onMounted(async () => {
        try {
            // Initialize time display
            updateTime()
            setInterval(updateTime, 1000)

            loading.value = true

            // Initialize viewer
            await initViewer('cesiumContainer')
            viewer = getViewer()
            viewerRef.value = viewer

            // Configure scene lighting
            configureSceneLighting()

            // Initialize geology manager
            geologyManager = new GeologyManager(viewer)

            // Load 3D model
            const loadResult = await load3DModel(['./3d/demo4/tileset.json'])
            modelLoadStatus.value = loadResult

            // Load measurement history from localStorage
            loadMeasurementHistory()

            tileset = getModelInstance()
            if (tileset) {
                if (tileset.readyPromise) {
                    tileset.readyPromise.then(async () => {
                        scanAndStoreFeatures()
                        initModelEventHandler()
                        await loadModelProperties()
                    }).catch(err => console.error('3D Tiles model loading failed:', err))
                } else {
                    scanAndStoreFeatures()
                    initModelEventHandler() // 添加这行代码，确保点击事件处理器被初始化
                    await loadModelProperties()
                }
            }

            // Update model position and transform from load result
            if (loadResult.position && loadResult.transform) {
                modelPosition.value = loadResult.position
                modelTransform.value = loadResult.transform
            }

            // Clear load status after delay
            if (modelLoadStatus.value) {
                setTimeout(() => modelLoadStatus.value = null, 3000)
            }
        } catch (error) {
            console.error('Initialization failed:', error)
            modelLoadStatus.value = { type: 'error', message: 'Initialization failed: ' + error.message }
            setTimeout(() => modelLoadStatus.value = null, 5000)
        } finally {
            loading.value = false
        }
    })

    onUnmounted(() => {
        // Cleanup resources
        destroyViewer()
        if (measurementHandler) measurementHandler.destroy()
        if (areaMeasurementHandler) areaMeasurementHandler.destroy()
    })

    // ===== Section Cutting Methods =====
    /**
     * Handle section added event
     * @param {Object} section - Section object
     */
    const handleSectionAdded = (section) => {
        console.log('Section added:', section)
        showOperationMessage(`剖面已添加: ${section.type}`, 'success')
    }

    /**
     * Handle section removed event
     * @param {Object} section - Section object
     */
    const handleSectionRemoved = (section) => {
        console.log('Section removed:', section)
        showOperationMessage(`剖面已移除: ${section.type}`, 'info')
    }

    /**
     * Handle section updated event
     * @param {Object} section - Section object
     */
    const handleSectionUpdated = (section) => {
        console.log('Section updated:', section)
        showOperationMessage(`剖面已更新: ${section.type}`, 'info')
    }

    /**
     * Handle model selected event
     * @param {Object} model - Model object
     */
    const handleModelSelected = (model) => {
        console.log('Model selected:', model)
        syncModelInfo(model)
        showOperationMessage(`模型已选中: ${model.name}`, 'success')
    }

    /**
     * Handle section mode changed event
     * @param {Boolean} isActive - Whether section mode is active
     */
    const handleSectionModeChanged = (isActive) => {
        console.log('Section mode changed:', isActive)
        showOperationMessage(`剖面模式${isActive ? '启用' : '禁用'}`, 'info')
    }

    // ===== Section Cutting Control Methods =====
    /**
     * Toggle section cutting mode
     * @param {Boolean} enabled - Whether to enable section cutting
     */
    const toggleSection = (enabled) => {
        isSectionEnabled.value = enabled
        if (!enabled && sectionPlaneEntity && viewer) {
            viewer.entities.remove(sectionPlaneEntity)
            sectionPlaneEntity = null
        }
        showOperationMessage(`剖面切割${enabled ? '已启用' : '已禁用'}`, 'info')
    }

    /**
     * Update section plane parameters
     * @param {Object} params - Section plane parameters
     */
    const updateSectionPlane = (params) => {
        if (params.direction !== undefined) sectionDirection.value = params.direction
        if (params.position !== undefined) sectionPosition.value = params.position
        if (params.thickness !== undefined) sectionThickness.value = params.thickness
        if (params.showPlane !== undefined) showSectionPlane.value = params.showPlane
        if (params.color !== undefined) sectionPlaneColor.value = params.color
        if (params.opacity !== undefined) sectionPlaneOpacity.value = params.opacity

        // Apply section plane visualization if enabled
        if (isSectionEnabled.value && viewer) {
            applySectionPlane()
        }
    }

    /**
     * Apply section plane to the scene
     */
    const applySectionPlane = () => {
        if (!viewer || !tileset) return

        // Remove existing section plane entity
        if (sectionPlaneEntity) {
            viewer.entities.remove(sectionPlaneEntity)
            sectionPlaneEntity = null
        }

        // Create clipping plane
        if (showSectionPlane.value) {
            try {
                const plane = createClippingPlane()
                if (plane) {
                    tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
                        planes: [plane],
                        edgeWidth: sectionThickness.value,
                        edgeColor: Cesium.Color.fromCssColorString(sectionPlaneColor.value)
                    })
                }
            } catch (e) {
                console.warn('Failed to create clipping plane:', e)
            }
        }
    }

    /**
     * Create clipping plane based on current parameters
     */
    const createClippingPlane = () => {
        let normal
        switch (sectionDirection.value) {
            case 'x':
                normal = new Cesium.Cartesian3(1, 0, 0)
                break
            case 'y':
                normal = new Cesium.Cartesian3(0, 1, 0)
                break
            case 'z':
            default:
                normal = new Cesium.Cartesian3(0, 0, 1)
                break
        }
        return new Cesium.ClippingPlane(normal, sectionPosition.value)
    }

    /**
     * Reset section cutting to default state
     */
    const resetSection = () => {
        sectionPosition.value = 0
        sectionThickness.value = 1
        sectionPlaneOpacity.value = 50

        // Clear clipping planes
        if (tileset) {
            tileset.clippingPlanes = undefined
        }

        if (sectionPlaneEntity && viewer) {
            viewer.entities.remove(sectionPlaneEntity)
            sectionPlaneEntity = null
        }

        showOperationMessage('剖面切割已重置', 'info')
    }

    /**
     * Toggle multiple sections mode
     * @param {Boolean} enabled - Whether to enable multiple sections
     */
    const toggleMultipleSections = (enabled) => {
        isMultipleSectionsEnabled.value = enabled
        showOperationMessage(`多切面模式${enabled ? '已启用' : '已禁用'}`, 'info')
    }

    // ===== Public API =====
    // Get viewer instance (reactive ref)
    const getViewerRef = () => viewerRef

    return {
        // States
        modelPosition,
        modelTransform,
        isCollapsed,
        activeTab,
        modelConfigFiles,
        currentConfigFile,
        modelList,
        globalOpacity,
        coordinateSystem,
        isMeasuring,
        isAreaMeasuring,
        measurementDistance,
        measurementArea,
        measurementHistory,
        modelLoadStatus,
        showMessage,
        operationMessage,
        operationMessageType,
        loading,
        selectedModel,
        displayedModelInfo,
        syncModelInfo,
        getViewerRef,
        viewerRef,

        // Section Cutting States
        isSectionEnabled,
        sectionDirection,
        sectionPosition,
        sectionThickness,
        showSectionPlane,
        sectionPlaneColor,
        sectionPlaneOpacity,
        sectionRange,
        isMultipleSectionsEnabled,
        displayQuality,
        terrainQuality,

        // Actions
        toggleCollapse,
        onConfigChange,
        toggleModelVisibility,
        updateModelOpacity,
        updateGlobalOpacity,
        showAllModels,
        hideAllModels,
        resetAllOpacity,
        toggleMeasurement,
        toggleAreaMeasurement,
        clearCurrentMeasurement,
        clearAllMeasurements,
        deleteMeasurementRecord,
        exportSceneData,
        exportReport,
        exportScreenshot,
        resetView,
        resetModel,
        fitToModels,
        toggleFullscreen,
        highlightModel,
        updateModelPosition,
        updateModelTransform,
        showOperationMessage,

        // Section Cutting Methods
        handleSectionAdded,
        handleSectionRemoved,
        handleSectionUpdated,
        handleModelSelected,
        handleSectionModeChanged,
        toggleSection,
        updateSectionPlane,
        resetSection,
        toggleMultipleSections,

        // Geology Analysis Methods
        initBoreholes,
        showBoreholeDetails,
        createGeologicalSection,
        calculateOreReserve,
        generateGeologyReport,
        exportBoreholeData,
        exportGeologyReport,
        calculateStratigraphyStats
    }
}