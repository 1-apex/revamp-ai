export type ElementRole = "interactive" | "text" | "layout" | "media" | "component" | "other";

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "option"]);
const TEXT_TAGS = new Set(["p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "label", "strong", "em", "small"]);
const LAYOUT_TAGS = new Set([
  "div", "section", "main", "header", "footer", "nav", "article", "aside",
  "ul", "ol", "li", "form", "table", "thead", "tbody", "tr", "td", "th",
]);
const MEDIA_TAGS = new Set(["svg", "img", "hr", "video", "picture", "canvas"]);
const INTERACTIVE_ATTRS = new Set([
  "onClick", "onChange", "onSubmit", "onKeyDown", "onKeyUp", "onFocus", "onBlur", "href",
]);

/**
 * Classify a JSX element's role from its tag name and attribute names.
 * This is a heuristic, not ground truth — it exists so a direction pack's
 * component recipes and the scan summary can talk about "how many
 * interactive elements does this route have" without a human counting.
 * A custom component tag (capitalized) is classified as "component" rather
 * than guessed at, since its real role depends on what it renders — that's
 * exactly what recipes and swap_primitive need to reason about separately.
 */
export function classifyRole(tagName: string, attributeNames: string[]): ElementRole {
  const isCustomComponent = /^[A-Z]/.test(tagName) || tagName.includes(".");
  if (isCustomComponent) return "component";

  const hasInteractiveAttr = attributeNames.some((a) => INTERACTIVE_ATTRS.has(a));
  if (INTERACTIVE_TAGS.has(tagName) || hasInteractiveAttr) return "interactive";
  if (TEXT_TAGS.has(tagName)) return "text";
  if (LAYOUT_TAGS.has(tagName)) return "layout";
  if (MEDIA_TAGS.has(tagName)) return "media";
  return "other";
}
