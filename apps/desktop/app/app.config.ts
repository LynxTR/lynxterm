const fieldSize = { sm: { base: "px-3 py-2 text-[13px]/4" }, md: { base: "px-3 py-2 text-sm/5" } };
const icon18 = { leadingIcon: "size-[18px]", trailingIcon: "size-[18px]" };

export default defineAppConfig({
  icon: {
    // Phosphor icons look small beside text (wide margins): scale up from centre of 256-unit box.
    customize: (content: string) =>
      `<g transform="translate(128 128) scale(1.14) translate(-128 -128)">${content}</g>`,
  },
  ui: {
    colors: { primary: "amber", neutral: "zinc" },
    icons: {
      arrowLeft: "i-ph-arrow-left",
      check: "i-ph-check",
      chevronDown: "i-ph-caret-down",
      chevronLeft: "i-ph-caret-left",
      chevronRight: "i-ph-caret-right",
      close: "i-ph-x",
      external: "i-ph-arrow-up-right",
      loading: "i-ph-circle-notch",
      menu: "i-ph-list",
      minus: "i-ph-minus",
      panelClose: "i-ph-sidebar-simple-duotone",
      panelOpen: "i-ph-sidebar-simple-duotone",
      search: "i-ph-magnifying-glass-duotone",
    },
    modal: { slots: { content: "bg-muted", footer: "justify-end gap-2" } },
    button: {
      defaultVariants: { color: "neutral" },
      variants: {
        size: {
          xs: { base: "px-2.5 py-1.5 text-xs gap-1.5" },
          sm: { base: "px-3 py-2 text-[13px]/4 gap-1.5" },
          md: { base: "px-3.5 py-2 text-sm gap-2", ...icon18 },
          lg: { base: "px-4 py-2.5 text-sm gap-2", ...icon18 },
        },
      },
      compoundVariants: [
        { square: true, size: "xs", class: "p-1.5" },
        { square: true, size: "sm", class: "p-2" },
        { square: true, size: "md", class: "p-2" },
        { square: true, size: "lg", class: "p-2.5" },
        { color: "neutral", variant: "outline", class: "bg-elevated hover:bg-accented" },
        { color: "neutral", variant: "ghost", class: "text-muted hover:text-default" },
      ],
    },
    kbd: { defaultVariants: { variant: "subtle" } },
    badge: {
      defaultVariants: { color: "neutral", variant: "outline" },
      compoundVariants: [
        {
          color: "neutral",
          variant: "outline",
          class: "rounded-full bg-elevated text-toned ring-default",
        },
        { color: "neutral", variant: "outline", size: "sm", class: "px-2 text-[11px]/4" },
      ],
    },
    // Dashboard parts sit below tab strip, not over whole viewport; shown under 1024px too
    // (window min width 900).
    dashboardGroup: { base: "relative inset-auto min-h-0 flex-1" },
    dashboardResizeHandle: { base: "block" },
    dashboardSidebarCollapse: { base: "flex" },
    dashboardSearchButton: { slots: { trailing: "flex" } },
    input: { variants: { size: { sm: fieldSize.sm, md: { ...fieldSize.md, ...icon18 } } } },
    select: { variants: { size: fieldSize } },
    selectMenu: { variants: { size: fieldSize } },
  },
});
