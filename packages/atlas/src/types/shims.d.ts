// Modules that ship no type declarations of their own.
//
// d3-force-3d is plain JS with no @types package. The Anthropic SDK is an
// OPTIONAL dependency: llm.ts imports it dynamically only when ANTHROPIC_API_KEY
// is set, and the default path shells out to the Claude Code CLI instead — so it
// is legitimately absent from node_modules most of the time.
declare module 'd3-force-3d';
declare module '@anthropic-ai/sdk';
