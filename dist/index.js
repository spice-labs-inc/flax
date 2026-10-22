// The programmatic surface of @flax/atlas: the config loader and the pieces a workspace's
// own inventory renderers or scripts may want. The command line is `flax atlas <cmd>`.
export { configOf, loadAtlas, config, paths, setConfig, validate, viewerConfig, DEFAULTS, SECTION, } from "./config.js";
export { renderTable, findBlocks, blockContent, replaceBlock, beginMarker, endMarker, } from "./atlas/markdown.js";
export { parseYaml } from "./atlas/yaml.js";
export { cmdCheck } from "./atlas/check.js";
export { findDrift, isNoise } from "./atlas/drift.js";
//# sourceMappingURL=index.js.map