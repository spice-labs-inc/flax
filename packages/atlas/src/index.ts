// The programmatic surface of @flax/atlas: the config loader and the pieces a workspace's
// own inventory renderers or scripts may want. The command line is `flax atlas <cmd>`.
export {
  configOf,
  loadAtlas,
  config,
  paths,
  setConfig,
  validate,
  viewerConfig,
  DEFAULTS,
  SECTION,
} from "./config.ts";
export type {
  AtlasConfig,
  AtlasPaths,
  PlaneDef,
  CuratedNode,
  CuratedEdge,
  ViewDef,
  InventoryDef,
  GitopsPathsCheck,
} from "./config.ts";
export type { ViewerConfig } from "./model/viewer-config.ts";
export type { RenderHelpers, Renderer } from "./atlas/inventories.ts";
export {
  renderTable,
  findBlocks,
  blockContent,
  replaceBlock,
  beginMarker,
  endMarker,
} from "./atlas/markdown.ts";
export { parseYaml } from "./atlas/yaml.ts";
export type { Yaml } from "./atlas/yaml.ts";
export { cmdCheck } from "./atlas/check.ts";
export { findDrift, isNoise } from "./atlas/drift.ts";
