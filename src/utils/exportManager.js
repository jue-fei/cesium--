export function exportSceneData(modelList, measurementHistory, coordinateSystem) {
    const data = { timestamp: new Date().toISOString(), models: modelList.map(m => ({ name: m.name, opacity: m.opacity, visible: m.visible })), measurements: measurementHistory, coordinateSystem }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `scene_data_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
}

export function exportReport(modelList, measurementHistory, coordinateSystem) {
    const html = `
    <html>
    <head><meta charset="UTF-8"><title>分析报告</title>
    <style>body{font-family:Arial;margin:20px;color:#333;}h1{color:#2d42b5;}.info{background:#f5f5f5;padding:10px;margin:10px 0;border-radius:4px;}</style>
    </head>
    <body>
    <h1>矿山3D模型分析报告</h1>
    <div class="info"><strong>生成时间:</strong> ${new Date().toLocaleString()}</div>
    <div class="info"><strong>坐标系:</strong> ${coordinateSystem}</div>
    <h2>模型信息</h2>
    <ul>${modelList.map(m => `<li>${m.name} - 透明度:${m.opacity}% - 状态:${m.visible ? '显示' : '隐藏'}</li>`).join('')}</ul>
    <h2>测量统计</h2>
    <p>总计 ${measurementHistory.length} 条测量记录</p>
    ${measurementHistory.length > 0 ? `<ul>${measurementHistory.slice(0, 5).map(r => `<li>${r.type === 'distance' ? '距离' : '面积'}: ${r.type === 'distance' ? r.distance.toFixed(2) + 'm' : r.area.toFixed(2) + 'm²'}</li>`).join('')}</ul>` : '<p>无测量数据</p>'}
    </body>
    </html>
    `
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `analysis_report_${Date.now()}.html`
    a.click()
    URL.revokeObjectURL(url)
}

export function exportScreenshot(viewer) {
    if (!viewer) return
    viewer.render()
    const canvas = viewer.scene.canvas
    canvas.toBlob(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `screenshot_${Date.now()}.png`; a.click(); URL.revokeObjectURL(url) })
}
