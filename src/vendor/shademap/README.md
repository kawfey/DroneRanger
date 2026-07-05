# Vendored ShadeMap Adaptation

This private module keeps the same Mapbox custom-layer and GPU texture lifecycle shape used by
`mapbox-gl-shadow-simulator`, but adapts the ray direction from parallel sun rays to radial
operator-origin line-of-sight coverage.

The v0 implementation is intentionally narrow:

- Mapbox owns camera, terrain, buildings, and render scheduling.
- `LosCoverageLayer` owns custom-layer lifecycle, shader compilation, framebuffer-ready coverage
  texture conventions, and uniforms.
- `CoverageRenderer` owns the WebGL program and radial coverage shader.
- `TerrainSource` and `ObstacleSource` are interfaces so Mapbox Terrain-DEM/building tile extraction
  can be filled in without replacing the renderer.

Tree canopy is represented as an obstacle source type, but disabled until a canopy height source is
available.
