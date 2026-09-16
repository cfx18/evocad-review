import * as THREE from "./vendor/three/three.module.min.js";
import { OrbitControls } from "./vendor/three/addons/controls/OrbitControls.js";
import { STLLoader } from "./vendor/three/addons/loaders/STLLoader.js";

const VIEW_DIRECTION = new THREE.Vector3(1, -1.25, 0.85).normalize();
const COLORS = {
  truth: 0x4397b8, candidate: 0xdf843d, missing: 0xef4fa6, excess: 0xffd23f,
};
let sharedRenderer = null;

function getSharedRenderer() {
  if (sharedRenderer) return sharedRenderer;
  const canvas = document.createElement("canvas");
  sharedRenderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power",
  });
  sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
  return sharedRenderer;
}

class GeometryViewport {
  constructor(container, manager) {
    this.container = container;
    this.manager = manager;
    this.canvas = container.querySelector("canvas");
    this.fallback = container.querySelector(".geometry-fallback");
    this.status = container.querySelector(".viewer-status");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1c252c);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);
    this.context = this.canvas.getContext("2d");
    if (!this.context) throw new Error("2D display canvas is unavailable");
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => this.manager.syncFrom(this));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x26323a, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(3, -4, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fc8df, 1.2);
    fill.position.set(-4, 2, 1);
    this.scene.add(fill);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  addGeometry(geometry, color, opacity = 1) {
    const material = new THREE.MeshStandardMaterial({
      color, roughness: 0.68, metalness: 0.05, transparent: opacity < 1,
      opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry.clone(), material);
    this.scene.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 28),
      new THREE.LineBasicMaterial({ color: 0xe7edf0, transparent: true, opacity: 0.32 }),
    );
    this.scene.add(edges);
  }

  addLocalization(points, color, pointSize) {
    if (!points?.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(
      points.flatMap((item) => item.point), 3,
    ));
    const material = new THREE.PointsMaterial({
      color, size: pointSize, sizeAttenuation: true, transparent: true, opacity: 0.95,
      depthTest: false,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = 20;
    this.scene.add(cloud);
  }

  addRegionBox(region, color) {
    const box = new THREE.Box3(
      new THREE.Vector3(...region.bbox.min),
      new THREE.Vector3(...region.bbox.max),
    );
    const helper = new THREE.Box3Helper(box, color);
    helper.material.transparent = true;
    helper.material.opacity = 0.82;
    helper.material.depthTest = false;
    helper.renderOrder = 21;
    this.scene.add(helper);
  }

  showInteractive() {
    this.container.dataset.viewerState = "ready";
    this.canvas.hidden = false;
    if (this.fallback) this.fallback.hidden = true;
    this.status.textContent = "3D";
  }

  showFallback(message) {
    this.container.dataset.viewerState = message === "Loading geometry" ? "loading" : "fallback";
    this.canvas.hidden = true;
    const hasFallback = Boolean(this.fallback?.getAttribute("src"));
    if (this.fallback) this.fallback.hidden = !hasFallback;
    this.status.textContent = hasFallback ? `PNG fallback: ${message}` : message;
  }

  resize() {
    this.updateProjectionBounds();
    this.render();
  }

  updateProjectionBounds() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const halfHeight = this.manager.frustumHeight / 2;
    const halfWidth = halfHeight * width / height;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (!this.canvas.hidden) this.manager.renderViewport(this);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((item) => {
      item.geometry?.dispose?.();
      if (Array.isArray(item.material)) item.material.forEach((material) => material.dispose());
      else item.material?.dispose?.();
    });
  }
}

class SynchronizedGeometryViewers {
  constructor(containers, geometry) {
    this.geometryPaths = geometry;
    this.frustumHeight = 1;
    this.globalFrustumHeight = 1;
    this.center = new THREE.Vector3();
    this.distance = 10;
    this.regions = new Map();
    this.pendingRegionId = null;
    this.syncing = false;
    this.disposed = false;
    this.renderer = getSharedRenderer();
    this.viewports = Object.fromEntries(
      Object.entries(containers).map(([name, container]) => [name, new GeometryViewport(container, this)]),
    );
    this.resetBindings = Object.values(containers).map((container) => {
      const button = container.querySelector(".reset-view");
      const handler = () => this.reset();
      button?.addEventListener("click", handler);
      return { button, handler };
    });
    this.load();
  }

  renderViewport(viewport) {
    const width = Math.max(1, viewport.container.clientWidth);
    const height = Math.max(1, viewport.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.render(viewport.scene, viewport.camera);
    const source = this.renderer.domElement;
    if (viewport.canvas.width !== source.width) viewport.canvas.width = source.width;
    if (viewport.canvas.height !== source.height) viewport.canvas.height = source.height;
    viewport.context.clearRect(0, 0, viewport.canvas.width, viewport.canvas.height);
    viewport.context.drawImage(source, 0, 0, viewport.canvas.width, viewport.canvas.height);
  }

  async loadGeometry(path) {
    if (!path) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Geometry request failed: ${response.status}`);
      const geometry = new STLLoader().parse(await response.arrayBuffer());
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      return geometry;
    } finally {
      clearTimeout(timeout);
    }
  }

  async loadLocalization(path) {
    if (!path) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Localization request failed: ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async load() {
    Object.values(this.viewports).forEach((viewport) => viewport.showFallback("Loading geometry"));
    try {
      const [truth, candidate, localization] = await Promise.all([
        this.loadGeometry(this.geometryPaths.ground_truth),
        this.loadGeometry(this.geometryPaths.candidate),
        this.loadLocalization(this.geometryPaths.localization),
      ]);
      if (this.disposed) {
        truth?.dispose();
        candidate?.dispose();
        return;
      }
      const bounds = new THREE.Box3();
      if (truth?.boundingBox) bounds.union(truth.boundingBox);
      if (candidate?.boundingBox) bounds.union(candidate.boundingBox);
      if (bounds.isEmpty()) throw new Error("No interactive geometry is available");
      bounds.getCenter(this.center);
      const size = bounds.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 1e-6);
      this.frustumHeight = span * 1.45;
      this.globalFrustumHeight = this.frustumHeight;
      this.distance = span * 4;
      if (truth) {
        this.viewports.truth.addGeometry(truth, COLORS.truth);
        this.viewports.truth.showInteractive();
        if (candidate) {
          this.viewports.overlay.addGeometry(truth, COLORS.truth, 0.48);
          this.viewports.overlay.showInteractive();
        }
      } else {
        this.viewports.truth.showFallback("Ground-truth geometry unavailable");
      }
      if (candidate) {
        this.viewports.candidate.addGeometry(candidate, COLORS.candidate);
        this.viewports.candidate.showInteractive();
        if (truth) {
          this.viewports.overlay.addGeometry(candidate, COLORS.candidate, 0.66);
          this.viewports.overlay.showInteractive();
        }
      } else {
        this.viewports.candidate.showFallback("Candidate geometry unavailable");
        if (!truth) this.viewports.overlay.showFallback("Overlay geometry unavailable");
      }
      if (!truth || !candidate) this.viewports.overlay.showFallback("Overlay requires both ground truth and candidate");
      const visualization = localization?.visualization || {};
      const missing = visualization.ground_truth_to_candidate || [];
      const excess = visualization.candidate_to_ground_truth || [];
      const pointSize = span * 0.014;
      this.viewports.truth.addLocalization(missing, COLORS.missing, pointSize);
      this.viewports.candidate.addLocalization(excess, COLORS.excess, pointSize);
      this.viewports.overlay.addLocalization(missing, COLORS.missing, pointSize);
      this.viewports.overlay.addLocalization(excess, COLORS.excess, pointSize);
      for (const region of localization?.regions || []) {
        this.regions.set(region.region_id, region);
        const isMissing = region.direction === "ground_truth_to_candidate";
        const color = isMissing ? COLORS.missing : COLORS.excess;
        (isMissing ? this.viewports.truth : this.viewports.candidate).addRegionBox(region, color);
        this.viewports.overlay.addRegionBox(region, color);
      }
      truth?.dispose();
      candidate?.dispose();
      this.reset();
      if (this.pendingRegionId) this.focusRegion(this.pendingRegionId);
    } catch (error) {
      if (this.disposed) return;
      Object.values(this.viewports).forEach((viewport) => viewport.showFallback(error.message));
    }
  }

  reset() {
    this.pendingRegionId = null;
    const source = Object.values(this.viewports).find((viewport) => !viewport.canvas.hidden);
    if (!source) return;
    this.frustumHeight = this.globalFrustumHeight;
    source.camera.position.copy(this.center).addScaledVector(VIEW_DIRECTION, this.distance);
    source.camera.up.set(0, 0, 1);
    source.camera.zoom = 1;
    source.controls.target.copy(this.center);
    source.camera.near = Math.max(this.distance / 1000, 0.001);
    source.camera.far = this.distance * 10;
    source.camera.updateProjectionMatrix();
    source.controls.update();
    this.syncFrom(source);
  }

  focusRegion(regionId) {
    this.pendingRegionId = regionId;
    const region = this.regions.get(regionId);
    const source = Object.values(this.viewports).find((viewport) => !viewport.canvas.hidden);
    if (!region || !source) return false;
    const center = new THREE.Vector3(...region.centroid);
    const lower = new THREE.Vector3(...region.bbox.min);
    const upper = new THREE.Vector3(...region.bbox.max);
    const regionSpan = Math.max(...upper.clone().sub(lower).toArray(), this.globalFrustumHeight * 0.04);
    const viewDirection = source.camera.position.clone().sub(source.controls.target).normalize();
    this.frustumHeight = Math.min(
      this.globalFrustumHeight,
      Math.max(regionSpan * 2.8, this.globalFrustumHeight * 0.12),
    );
    source.controls.target.copy(center);
    source.camera.position.copy(center).addScaledVector(viewDirection, this.distance);
    source.camera.zoom = 1;
    source.camera.updateProjectionMatrix();
    source.controls.update();
    this.syncFrom(source);
    Object.values(this.viewports).forEach((viewport) => {
      viewport.updateProjectionBounds();
      viewport.render();
    });
    return true;
  }

  syncFrom(source) {
    if (this.syncing || this.disposed) return;
    this.syncing = true;
    for (const viewport of Object.values(this.viewports)) {
      if (viewport !== source) {
        viewport.camera.position.copy(source.camera.position);
        viewport.camera.quaternion.copy(source.camera.quaternion);
        viewport.camera.up.copy(source.camera.up);
        viewport.camera.zoom = source.camera.zoom;
        viewport.camera.near = source.camera.near;
        viewport.camera.far = source.camera.far;
        viewport.controls.target.copy(source.controls.target);
        viewport.camera.updateProjectionMatrix();
        viewport.controls.update();
      }
      // Loading or resetting geometry changes the frustum without a DOM resize.
      viewport.updateProjectionBounds();
      viewport.render();
    }
    this.syncing = false;
  }

  dispose() {
    this.disposed = true;
    this.resetBindings.forEach(({ button, handler }) => button?.removeEventListener("click", handler));
    Object.values(this.viewports).forEach((viewport) => viewport.dispose());
  }
}

export function createSynchronizedGeometryViewers({ containers, geometry }) {
  try {
    return new SynchronizedGeometryViewers(containers, geometry);
  } catch (error) {
    Object.values(containers).filter(Boolean).forEach((container) => {
      const canvas = container.querySelector("canvas");
      const fallback = container.querySelector(".geometry-fallback");
      const status = container.querySelector(".viewer-status");
      if (canvas) canvas.hidden = true;
      const hasFallback = Boolean(fallback?.getAttribute("src"));
      if (fallback) fallback.hidden = !hasFallback;
      if (status) status.textContent = hasFallback
        ? `PNG fallback: 3D viewer unavailable: ${error.message}`
        : `3D viewer unavailable: ${error.message}`;
      container.dataset.viewerState = "fallback";
    });
    return { dispose() {} };
  }
}
