import arrowUp from "@phosphor-icons/core/assets/fill/arrow-up-fill.svg?raw";
import caretRight from "@phosphor-icons/core/assets/fill/caret-right-fill.svg?raw";
import gear from "@phosphor-icons/core/assets/fill/gear-fill.svg?raw";
import moonStars from "@phosphor-icons/core/assets/fill/moon-stars-fill.svg?raw";
import square from "@phosphor-icons/core/assets/fill/square-fill.svg?raw";

/** Shared frame for the hand-drawn line icons: 16px grid, currentColor. */
function line(paths: string): string {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths +
    "</svg>"
  );
}

/** One line icon per story tool, in the same weight as the rail icons. */
const TOOL_GLYPHS = {
  "tool-recall": line('<path d="M2 8a6 6 0 1 0 2-4.5"/><path d="M2 2v3.5h3.5"/>'),
  "tool-remember": line('<path d="M4.6 2.4h6.8v11.2L8 10.8l-3.4 2.8z"/>'),
  "tool-set_scene": line(
    '<path d="M9.2 2.4H3.6v11.2h5.6"/><path d="M6.6 8h7"/><path d="M11.1 5.5 13.6 8l-2.5 2.5"/>',
  ),
  "tool-update_character": line(
    '<path d="M2.6 5.4h10.8"/><path d="M10.9 3 13.4 5.4 10.9 7.8"/><path d="M13.4 10.6H2.6"/><path d="M5.1 8.2 2.6 10.6 5.1 13"/>',
  ),
  "tool-record_beat": line(
    '<path d="M2.4 8h11.2"/><circle cx="4.2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="11.8" cy="8" r="1.3"/>',
  ),
  "tool-roll": line(
    '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4"/><circle cx="5.8" cy="5.8" r="0.9" fill="currentColor"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><circle cx="10.2" cy="10.2" r="0.9" fill="currentColor"/>',
  ),
  "tool-write_lore": line(
    '<path d="M4.8 2.5h7.4a1 1 0 0 1 1 1v10H4.8a1.5 1.5 0 0 1-1.5-1.5V4a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M4.8 2.5v11"/><path d="M6.9 5.8h4"/><path d="M6.9 8.4h3"/>',
  ),
  "tool-create_character": line(
    '<circle cx="6.2" cy="5.4" r="2.2"/><path d="M2.4 13.2a3.9 3.9 0 0 1 7.6 0"/><path d="M12.2 3.4v4"/><path d="M10.2 5.4h4"/>',
  ),
  "tool-revise_character": line(
    '<circle cx="5.6" cy="5.2" r="2.1"/><path d="M2 13a3.7 3.7 0 0 1 7.2 0"/><circle cx="12" cy="11" r="2"/><path d="M12 8.3v.7"/><path d="M12 13v.7"/><path d="M9.3 11h.7"/><path d="M14 11h.7"/>',
  ),
  "tool-rewrite_world": line(
    '<ellipse cx="8" cy="8" rx="6.2" ry="2.8" transform="rotate(-20 8 8)"/><path d="M8 4.4 8.7 7.3 11.6 8 8.7 8.7 8 11.6 7.3 8.7 4.4 8 7.3 7.3z"/>',
  ),
  "tool-rewind": line(
    '<path d="M2.3 8a5.7 5.7 0 1 0 1.8-4.2"/><path d="M2.3 3v2.6h2.6"/><path d="M8 5.3V8l2 1.3"/>',
  ),
  "tool-oracle": line(
    '<path d="M6.2 2.6h3.6l1.7 8.6H4.5z"/><path d="M3.2 13.4h9.6"/><path d="M6.2 2.6 4.6 1.2"/><path d="M9.8 2.6 11.4 1.2"/>',
  ),
} as const;

/** Inline SVGs shipped with the app; Phosphor Icons, MIT. */
const ICONS = {
  "arrow-up": arrowUp,
  "caret-right": caretRight,
  gear,
  "moon-stars": moonStars,
  square,
  ...TOOL_GLYPHS,
} as const;

export type IconName = keyof typeof ICONS;

/** Bubble icon for each tool name. */
export const TOOL_ICONS: Record<string, IconName> = {
  recall: "tool-recall",
  remember: "tool-remember",
  set_scene: "tool-set_scene",
  update_character: "tool-update_character",
  record_beat: "tool-record_beat",
  roll: "tool-roll",
  write_lore: "tool-write_lore",
  create_character: "tool-create_character",
  revise_character: "tool-revise_character",
  rewrite_world: "tool-rewrite_world",
  rewind: "tool-rewind",
  oracle: "tool-oracle",
};

/** Inline markup for one icon, for places that build nodes in JS. */
export function iconMarkup(name: IconName): string {
  return ICONS[name] ?? "";
}

/** Fills every [data-icon] slot with its inline SVG. */
export function mountIcons(): void {
  for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = slot.dataset.icon as IconName | undefined;
    if (name && name in ICONS) slot.innerHTML = ICONS[name];
  }
}
