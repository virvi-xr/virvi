// The scene renderer's page. scene_render.py drives it through window.__scene. Positions it's given are glTF
// (right-handed, metres, +Z the model's front). Babylon is left-handed, and its glTF loader turns a model so that glTF
// (x, y, z) lands at Babylon (-x, y, z): positions go through `b()` the same way.
(() => {
  const canvas = document.getElementById('c')
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
  const scene = new BABYLON.Scene(engine)
  scene.clearColor = BABYLON.Color4.FromHexString('#5c6370ff')
  // Decentraland's look is flat: one soft light from above, no shadows
  const sky = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(0.3, 1, -0.2), scene)
  sky.intensity = 1.15
  sky.groundColor = new BABYLON.Color3(0.45, 0.45, 0.5)
  const orbitCam = new BABYLON.ArcRotateCamera('orbit', -Math.PI / 2, Math.PI / 2, 5, BABYLON.Vector3.Zero(), scene)
  orbitCam.lowerBetaLimit = null
  orbitCam.upperBetaLimit = null
  orbitCam.minZ = 0.02
  const eyeCam = new BABYLON.UniversalCamera('eye', BABYLON.Vector3.Zero(), scene)
  eyeCam.minZ = 0.05
  eyeCam.fov = 1.2
  scene.activeCamera = orbitCam
  const visible = []
  const b64 = (s) => 'data:model/gltf-binary;base64,' + s
  const b = (x, y, z) => new BABYLON.Vector3(-x, y, z)

  function box() {
    let min = new BABYLON.Vector3(Infinity, Infinity, Infinity), max = min.scale(-1)
    for (const m of visible) {
      m.computeWorldMatrix(true)
      const b = m.getBoundingInfo().boundingBox
      min = BABYLON.Vector3.Minimize(min, b.minimumWorld)
      max = BABYLON.Vector3.Maximize(max, b.maximumWorld)
    }
    return { min, max }
  }

  window.__scene = {
    ready: true,
    async load(files, items) {
      let triangles = 0
      for (const it of items) {
        const res = await BABYLON.SceneLoader.ImportMeshAsync('', '', b64(files[it.file]), scene, null, '.glb')
        const holder = new BABYLON.TransformNode('holder-' + it.category, scene)
        res.meshes[0].parent = holder
        if (it.at) {
          holder.position = b(it.at.x || 0, 0, it.at.z || 0)
          holder.rotation.y = -((it.at.yaw || 0) * Math.PI / 180)
        }
        for (const m of res.meshes) {
          if (/_collider(_(box|sphere|capsule))?$/i.test(m.name) || /_collider(_(box|sphere|capsule))?$/i.test(m.parent?.name || '')) {
            m.isVisible = false
          } else if (m.getTotalVertices() > 0) {
            visible.push(m)
            triangles += (m.getTotalIndices() || m.getTotalVertices()) / 3
          }
        }
      }
      const { min, max } = box()
      return { triangles, min: min.asArray(), max: max.asArray() }
    },
    frameOrbit(scaleMargin) {
      const { min, max } = box()
      const centre = min.add(max).scale(0.5)
      const radius = max.subtract(min).length() / 2 || 1
      scene.activeCamera = orbitCam
      orbitCam.target = centre
      orbitCam.alpha = Math.PI / 2  // at Babylon +Z, which is the model's front (glTF +Z)
      orbitCam.beta = Math.PI / 2
      orbitCam.radius = (radius * (scaleMargin || 1.15)) / Math.sin(orbitCam.fov / 2)
    },
    orbit(dAlpha, dBeta) {
      orbitCam.alpha += dAlpha || 0
      // ArcRotateCamera degenerates at the poles: keep a hair off them
      orbitCam.beta = Math.min(Math.PI - 1e-4, Math.max(1e-4, orbitCam.beta + (dBeta || 0)))
    },
    // In Babylon's own coordinates (beside the bounding box load() returned)
    mannequin(x, z) {
      const mat = new BABYLON.StandardMaterial('mannequin', scene)
      mat.diffuseColor = new BABYLON.Color3(0.78, 0.8, 0.84)
      const body = BABYLON.MeshBuilder.CreateCapsule('mannequin', { height: 1.55, radius: 0.2 }, scene)
      body.position = new BABYLON.Vector3(x, 0.775, z)
      const head = BABYLON.MeshBuilder.CreateSphere('mannequin-head', { diameter: 0.25 }, scene)
      head.position = new BABYLON.Vector3(x, 1.675, z)
      for (const m of [body, head]) { m.material = mat; visible.push(m) }
    },
    // A scene stands on ground: a walk-through looking out of a window or away from the building sees it
    ground() {
      const mat = new BABYLON.StandardMaterial('ground', scene)
      mat.diffuseColor = new BABYLON.Color3(0.42, 0.55, 0.37)
      mat.specularColor = BABYLON.Color3.Black()
      const g = BABYLON.MeshBuilder.CreateGround('ground', { width: 400, height: 400 }, scene)
      g.position.y = -0.002  // just under the floors, so they don't flicker against it
      g.material = mat
    },
    eye(x, y, z, tx, ty, tz) {
      scene.activeCamera = eyeCam
      eyeCam.position = b(x, y, z)
      eyeCam.setTarget(b(tx, ty, tz))
    },
    // Shaders compile asynchronously and a mesh whose shader isn't ready is skipped: wait, then draw
    async frame() { await scene.whenReadyAsync(); scene.render(); return true },
  }
})()
