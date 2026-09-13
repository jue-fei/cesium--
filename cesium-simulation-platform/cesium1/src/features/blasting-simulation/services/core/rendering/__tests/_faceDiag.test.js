import { describe, it, beforeAll } from 'vitest'
import * as THREE from 'three'
import { SceneBuilder } from '../sceneBuilder.js'
import { removeTrianglesOnPlane } from '../geometrySmoothing.js'

function canvas(ctx) { return { width: 0, height: 0, getContext: () => ctx } }
function makeCtx() {
  return { fillStyle:'',strokeStyle:'',lineWidth:1,textBaseline:'alphabetic',font:'',
    fillRect(){},strokeRect(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},
    stroke(){},measureText(t){return{width:String(t||'').length*12}},fillText(){},
    scale(){},translate(){},rotate(){},setTransform(){},save(){},restore(){},clearRect(){} }
}
beforeAll(() => { if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => canvas(makeCtx()) } })

// replicate the same build steps inside _buildRockBodyMesh but keep each piece separate
function buildPieces() {
  const scene = new THREE.Scene()
  const config = {
    center: new THREE.Vector3(0, 0, 0), faceDirection: new THREE.Vector3(0, 0, 1),
    layerVisibility: { face: true }, tunnelWidth: 18, tunnelWallHeight: 6, tunnelArchRadius: 9,
    tunnelHeight: 15, benchLength: 40,
    tunnelSection: { tunnelWidth: 18, tunnelHeight: 15, tunnelWallHeight: 6, tunnelArchRadius: 9 },
    designParams: { holeDepth: 2.5 }, craterSeed: 7
  }
  const sb = new SceneBuilder(scene, config)
  const ctx = sb._buildBenchContext ? null : null
  // reconstruct context like buildBenchGeometry does
  sb.buildBenchGeometry()
  const post = sb._rockGeoPost
  return { sb, post }
}

// Count triangles on plane z=rd, split by region (tunnel vs annulus) and winding (face z dir)
function report(label, geo, rd, tol = 0.05) {
  const pos = geo.attributes.position.array
  const idx = geo.index ? geo.index.array : null
  const tc = idx ? idx.length / 3 : geo.attributes.position.count / 3
  let tunnelPosZ=[], tunnelNegZ=[], annulusPosZ=[], annulusNegZ=[], wall=0
  for (let t=0;t<tc;t++){
    const a=idx?idx[t*3]:t*3,b=idx?idx[t*3+1]:t*3+1,c=idx?idx[t*3+2]:t*3+2
    const za=pos[a*3+2],zb=pos[b*3+2],zc=pos[c*3+2]
    if (Math.abs(za-rd)<tol&&Math.abs(zb-rd)<tol&&Math.abs(zc-rd)<tol){
      const cx=(pos[a*3]+pos[b*3]+pos[c*3])/3
      const cy=(pos[a*3+1]+pos[b*3+1]+pos[c*3+1])/3
      // tunnel region if inside wall box and arch: |x|<=9 && y in [0..15] horseshoe-ish
      const halfW=9, Hw=6, R=9
      let inTunnel=false
      if (cy<=Hw){ inTunnel = Math.abs(cx)<=halfW }
      else { const dy=cy-Hw; inTunnel = cx*cx+dy*dy<=R*R }
      const e1x=pos[b*3]-pos[a*3], e1y=pos[b*3+1]-pos[a*3+1]
      const e2x=pos[c*3]-pos[a*3], e2y=pos[c*3+1]-pos[a*3+1]
      const nz=e1x*e2y-e1y*e2x
      const neg = nz<0
      if (inTunnel){ if(neg)tunnelNegZ++; else tunnelPosZ++ } else { if(neg)annulusNegZ++; else annulusPosZ++ }
    }
  }
  console.log(`[${label}] rd=${rd} trisOnPlane(t${tunnelNegZ}+t${tunnelPosZ} / a${annulusNegZ}+a${annulusPosZ})  tunnel: -z=${tunnelNegZ} +z=${tunnelPosZ}; annulus: -z=${annulusNegZ} +z=${annulusPosZ}`)
}

describe('face plane wind / overlap diagnostics', () => {
  it('replicate pieces independently', () => {
    const { sb, post } = buildPieces()
    // rebuild pieces manually mirroring _buildRockBodyMesh
    const W=18,Hw=6,R=9,th=15
    const ctx = sb
    const tunnelShape = sb._createTunnelShape(0, W, Hw, R, th)
    const rockShape = sb._createRockShape ? sb._createRockShape(W,Hw,R,th) : null
    const roundDepth = 2.125
    const ringShape = sb._buildRockRingShape(W,Hw,R, ctx.rockThickness||5, tunnelShape)
    const extrudeOpts = { bevelEnabled:false, steps:48, curveSegments:64 }
    const ringWallRaw = new THREE.ExtrudeGeometry(ringShape, {...extrudeOpts, depth:roundDepth})
    report('ringWall RAW (before rm)', ringWallRaw, roundDepth)
    const ring1 = removeTrianglesOnPlane(ringWallRaw, 2, roundDepth, 1)
    report('ringWall rm(+1)  @rd', ring1, roundDepth)
    const ring2 = removeTrianglesOnPlane(ring1, 2, roundDepth, -1)
    report('ringWall rm(-1)  @rd', ring2, roundDepth)
    const coreRaw = new THREE.ExtrudeGeometry(rockShape, {...extrudeOpts, depth: 40})
    coreRaw.translate(0,0,roundDepth)
    report('coreSolid RAW @rd (after translate)', coreRaw, roundDepth)
    const core1 = new THREE.ExtrudeGeometry(rockShape, {...extrudeOpts, depth:40})
    core1 = removeTrianglesOnPlane(core1, 2, 0, 1)
    core1 = removeTrianglesOnPlane(core1, 2, 0, -1)
    core1.translate(0,0,roundDepth)
    report('coreSolid after rm+translate @rd', core1, roundDepth)
    let disc = new THREE.ShapeGeometry(tunnelShape, 64)
    const da = disc.index.array
    for (let i=0;i<da.length;i+=3){const t=da[i+1];da[i+1]=da[i+2];da[i+2]=t}
    disc.translate(0,0,roundDepth)
    report('centerDisc (reversed) @rd', disc, roundDepth)
  })
})