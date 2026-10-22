import * as markdown from "prettier/plugins/markdown";
import * as yaml from "prettier/plugins/yaml";
import { format as prettierFormat } from "prettier/standalone";

/**
 * Prettier with only the parsers generated files need, in its standalone
 * build: the same output as prettier's Node entry, but bundleable, so the
 * bundled runner can check the generated files too.
 */
export function format(
  text: string,
  options: { parser: "yaml" | "markdown" },
): Promise<string> {
  return prettierFormat(text, { ...options, plugins: [yaml, markdown] });
}
