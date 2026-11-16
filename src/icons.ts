import arrowUp from "@phosphor-icons/core/assets/fill/arrow-up-fill.svg?raw";
import caretRight from "@phosphor-icons/core/assets/fill/caret-right-fill.svg?raw";
import gear from "@phosphor-icons/core/assets/fill/gear-fill.svg?raw";
import square from "@phosphor-icons/core/assets/fill/square-fill.svg?raw";

/** Inline SVGs shipped with the app; Phosphor Icons, MIT. */
const ICONS = {
  "arrow-up": arrowUp,
  "caret-right": caretRight,
  gear,
  square,
} as const;

export type IconName = keyof typeof ICONS;

/** Fills every [data-icon] slot with its inline SVG. */
export function mountIcons(): void {
  for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = slot.dataset.icon as IconName | undefined;
    if (name && name in ICONS) slot.innerHTML = ICONS[name];
  }
}
