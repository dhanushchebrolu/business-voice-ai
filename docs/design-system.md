# ClickAI public website design system

Generated with the installed UI/UX Pro Max skill (`.claude/skills/ui-ux-pro-max/scripts/design_system.py`,
query: "AI business automation SaaS voice agents enterprise premium dark navy") and then adapted to the ClickAI brand.

## What the skill recommended, and what we kept

| Skill output                                                                                | Decision                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pattern "Product Demo + Features": hero, product mockup, per-feature breakdown, CTA         | **Kept.** Home = hero with the live assistant, product showcase, process, industries, integrations, why, FAQ, CTA.                                                                  |
| Style "Minimalism & Swiss": spacious, grid-based, high contrast, sharp shadows              | **Kept**, with a dark/light section rhythm to add depth.                                                                                                                            |
| Typography "Inter, dark, cinematic, technical, precision"                                   | **Adapted.** The repo already ships Manrope (UI) and Instrument Serif (display); both are kept so no new font loads. Serif is used for display headlines, sans for everything else. |
| Colors: red primary (#DC2626), "recording red"                                              | **Rejected.** Conflicts with the supplied ClickAI logo (blue→violet gradient wordmark). Brand blue is the primary.                                                                  |
| Effects: subtle 200–250 ms hover, sharp shadows, no excess decoration                       | **Kept.**                                                                                                                                                                           |
| Checklist: no emoji icons, cursor-pointer, visible focus, reduced motion, 375/768/1024/1440 | **Kept** and used as the QA list.                                                                                                                                                   |

## Colour tokens (Tailwind v4 `@theme`, `src/styles.css`)

| Token                                       | Value                                                        | Use                                     |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `ink-950`                                   | `#060b1f`                                                    | Hero, closing CTA, footer               |
| `ink-900`                                   | `#0b1330`                                                    | Raised surfaces on dark                 |
| `ink-800`                                   | `#121c40`                                                    | Borders/dividers on dark use `white/10` |
| `paper`                                     | `#faf8f4`                                                    | Warm off-white alternating sections     |
| `brand-500` / `600`                         | electric blue (`oklch(.62 .2 260)` / `(.55 .23 262)`)        | Primary accent, CTAs                    |
| `violet-*` (mapped to blue on public pages) | see `.theme-light`                                           | Existing components keep working        |
| Secondary accent                            | restrained violet `#7c5cff`, used only for gradients on dark | Never as text on white                  |

Text: `slate-900` on light, `white` / `slate-300` on dark (contrast ≥ 4.5:1). `slate-500` is the lightest allowed body text on white.

## Section rhythm

1. Light header (the supplied logo has a dark wordmark and is shown on white/transparent only; on dark surfaces it sits on a white plate).
2. **Dark** hero (`ink-950`).
3. **Paper** product showcase.
4. White editorial process.
5. **Dark** industries.
6. White integrations ledger (table, not cards).
7. **Paper** why ClickAI.
8. **Dark** demo + FAQ → closing CTA → footer.

Rules: not every section is a card; use hairline rules and typography for structure; at most one glow per section and only behind the assistant.

## Typography

- Display: Instrument Serif, `clamp(2.5rem, 6vw, 4.5rem)`, tight leading (1.04), used for page H1 and section H2 on the home page.
- UI/body: Manrope, 16 px base, line-height 1.6, max line length ~65ch.
- Eyebrows: 12 px, uppercase, `tracking-[0.18em]`.

## Layout

- Container `max-w-[1200px]`, gutters 20 px (mobile) / 32 px (≥ sm).
- Section padding 80 px mobile / 112 px desktop.
- Breakpoints: Tailwind defaults (sm 640, md 768, lg 1024, xl 1280).

## Motion

- Durations: 150 ms (hover), 250 ms (menus), 700 ms (reveal). Easing: `ease-out`.
- Reveals (`Reveal`): opacity + 16 px translate, once, only for content below the fold; staggered with `delay`.
- Menus/drawer: opacity + 8 px translate keyframes (`animate-menu`).
- Everything is disabled under `prefers-reduced-motion`. No animation library is used.

## Content rules

No invented customers, metrics, testimonials, certifications or integrations. Each capability is labelled
Available / Needs setup / Custom. Product mock-ups only show features that exist in the product (weekly hours and
date overrides, Google Calendar, YES-to-confirm WhatsApp bookings, human handoff, call history) and are labelled
"illustrative" where the text is an example.
