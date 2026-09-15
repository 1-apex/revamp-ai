import { parse } from "@babel/parser";
import type { File } from "@babel/types";

/**
 * Parse a TSX/JSX/TS source file into a Babel AST.
 * We deliberately enable jsx + typescript plugins only — this engine
 * never needs to understand Flow, decorators-legacy, etc. for its
 * target stack (Vite/Next + React 19 + TS).
 */
export function parseSource(source: string, filename: string): File {
  return parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["jsx", "typescript"],
    errorRecovery: false,
  });
}
