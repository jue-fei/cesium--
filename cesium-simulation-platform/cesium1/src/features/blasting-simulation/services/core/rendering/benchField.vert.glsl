precision highp float;
precision highp sampler3D;

// 顶点世界坐标（用于换算到 grid 采样坐标）
out vec3 vWorldPos;
out vec2 vUv;
out vec3 vWorldNormal;

void main() {
  // 岩石底纹 UV 缩放【摩尔纹修复】
  // ExtrudeGeometry/ShapeGeometry 的 UV 直接是局部坐标米数（非归一化 0~1），于是
  // 512px 岩石纹理按"1 米一格"平铺：144m×141m 的正面铺 144×141 次，屏幕上每格约 2px，
  // 纹理频率远高于像素采样率 → 摩尔纹/颗粒，格线随透视呈斜向条纹（用户所报"裂痕"）。
  // 缩放后每格覆盖 100m，正面只重复约 1.4 次（单格约 200px），离开摩尔纹区。
  // 注：uv 同时驱动法线扰动的第二采样（vUv*1.6），故在顶点阶段统一缩放使两者一致。
  vUv = uv * ${ROCK_UV_SCALE_NUM};
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // 世界空间法线（用于简单的 lambert 明暗，让岩面有起伏光感而非纯平色）
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
