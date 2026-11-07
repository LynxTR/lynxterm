import { useResizeObserver } from "@vueuse/core";
import type { WatchSource } from "vue";

/** Active item's box in `container`: one highlight glides between items. Remeasures on `on`
 *  change, resize, `measure()`. */
export function useIndicator(container: Ref<HTMLElement | null>, on: WatchSource, active: string) {
  const box = ref({ left: 0, top: 0, width: 0, height: 0, shown: false });
  function measure() {
    const c = container.value;
    const el = c?.querySelector<HTMLElement>(active);
    if (!c || !el) return void (box.value.shown = false);
    const [a, b] = [c.getBoundingClientRect(), el.getBoundingClientRect()];
    box.value = {
      left: b.left - a.left,
      top: b.top - a.top,
      width: b.width,
      height: b.height,
      shown: true,
    };
  }
  watch(on, () => nextTick(measure), { immediate: true, flush: "post" });
  useResizeObserver(container, measure);
  return { box, measure };
}
