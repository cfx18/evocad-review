# Vendored review dependencies

The review bundle vendors Three.js `0.185.1` so exported evidence remains
self-contained and does not depend on a CDN at review time.

- `three/three.module.min.js`: `three/build/three.module.min.js`
- `three/three.core.min.js`: core module imported by `three.module.min.js`
- `three/addons/controls/OrbitControls.js`: synchronized camera controls
- `three/addons/loaders/STLLoader.js`: browser loading for hashed STL evidence
- `three/LICENSE.txt`: upstream MIT license

The two addon imports are patched from the bare `three` specifier to the
vendored relative module path. This removes the runtime import-map dependency;
all other upstream source is unchanged.

Source package: <https://www.npmjs.com/package/three/v/0.185.1>
