precision highp float;
precision highp sampler3D;

// 顶点世界坐标（用于换算到 grid 采样坐标）
out vec3 vWorldPos;
out vec2 vUv;
out vec3 vWorldNormal;
// 视线方向（片元到相机）：用于轮廓高光（rim），让纯色平铺时也能看清模型轮廓
out vec3 vViewDir;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // 世界空间法线（用于简单的 lambert 明暗，让岩面有起伏光感而非纯平色）
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
