# ClickAI homepage: how the UI/UX Pro Max output was used

Everything below refers to files in this folder. Nothing was edited by hand in `MASTER.md`, `pages/home.md` or `research.log`; they are the skill's own output.

## Commands actually run (from the repo root, Python 3, Windows)

```
python .claude/skills/ui-ux-pro-max/scripts/search.py "AI voice agents business automation SaaS premium enterprise dark" \
  --design-system --persist -p "ClickAI" --output-dir . --variance 6 --motion 4 --density 4
python ...search.py "<same query>" --design-system --persist -p "ClickAI" --page "home" --output-dir . --variance 6 --motion 4 --density 4
```

Fourteen focused searches follow in `research.log` (each logged with its exact command line):
`--domain product|style|typography|color|landing|ux (x4)|gsap|react` and `--stack html-tailwind|shadcn|react`,
plus one retry design-system query (not persisted, because `MASTER.md` already existed and the skill says not to overwrite it
without authorisation): `"AI chatbot platform B2B SaaS enterprise"`.

## Outputs

- `MASTER.md`: persisted design system (global rules).
- `pages/home.md`: persisted home-page overrides.
- `research.log`: raw output of all searches.

Known weakness in the skill output: the first query was classified as category **"Voice Recorder & Memo"** with a **red** primary (#DC2626),
and `pages/home.md` asks for a narrow 800 px single column. The retry classified the product as "AI-Native UI" with an AI-purple primary.
Both were treated as inputs, not instructions (the skill itself says dataset text is a recommendation).

## Selected and applied

| Skill recommendation | Source | Where it shows up on the homepage |
| --- | --- | --- |
| Pattern **Product Demo + Features**: hero, product mockup, feature breakdown, optional comparison, CTA | `MASTER.md` Page Pattern; `--domain landing` result 1 | Section order: hero with live assistant, product showcase, process, industries, integrations, **comparison** ("Why ClickAI"), demo, FAQ, CTA |
| "Use an interactive demo only when it explains value; provide captions/transcript, visible controls, non-video fallback; pause offscreen" | `MASTER.md` Conversion Strategy | Hero assistant keeps its transcript, Stop/Restart, text fallback and static orb fallback; WebGPU orb pauses offscreen (vendored gate) |
| Style **Minimalism & Swiss**: grid-based, high contrast, functional | `MASTER.md` Style | Hairline column grid, ruled lists, mono labels, no card shadows except the product surface |
| **Trust blue #2563EB** primary for SaaS | `--domain color` result 1 | Matches the existing brand blue (`oklch(.55 .23 262)` ~ #2563EB) |
| Dark mode: desaturated/lighter tonal variants, contrast >= 4.5:1, no inverted palettes | SKILL.md `color-dark-mode`, style `dark-mode-oled` | Dark sections use `ink-950/900` with `slate-300` text (>= 4.5:1) and `sky-300` accents |
| Serif + sans pairing for premium/editorial feel | `--domain typography` ("Classic Elegant", "News Editorial") | Display serif headings + sans UI, realised with the fonts already loaded (Instrument Serif, Manrope) so no font request is added |
| Smooth scroll on `html`; reduced motion honoured; final state shown without scroll effects | `--domain ux` | `scroll-behavior: smooth` behind `prefers-reduced-motion: no-preference`; `Reveal` shows content immediately for reduced-motion and no-JS |
| Scroll reveal: y offset 8-16 px, **do not hide SEO content without a no-JS fallback** | `--domain gsap` Scroll Reveal | `Reveal` is visible on the server, only hides below-the-fold content after mount, 16 px offset |
| Animate 1-2 key elements per view; stagger 30-50 ms | `--domain ux`, SKILL `stagger-sequence` | Hero assistant is the one persistent animation; stagger delays set to 40 ms steps |
| One primary CTA per screen; secondary subordinate | SKILL `primary-action` | Header "Get Started" demoted to outline so "Book a Demo" is the only filled CTA |
| Tabs/Accordion from shadcn, not custom | `--stack shadcn` | Showcase uses Radix `Tabs` (vertical); FAQ uses `Accordion` |
| Lazy/dynamic import for heavy components, Suspense | `--domain react`, `--stack react` | OrbBloop/vgpu loaded with `lazy()` + `Suspense`, only when WebGPU exists |
| Tailwind v4: use `bg-linear-to-*`, not `bg-gradient-to-*` | `--stack html-tailwind` | Hero gradient text uses `bg-linear-to-r` |
| Skip link, tab order matches visual order | `--domain ux` Skip Links / Keyboard Navigation | "Skip to main content" link added to the homepage |
| "Clearly label AI generated content"; avoid "Present AI as human" | `pages/home.md` | Assistant labelled "AI answers, not a phone call"; examples labelled illustrative |
| Pre-delivery checklist (focus, reduced motion, contrast, 375/768/1024/1440) | `--design-system` output | Browser checks at 375, 768, 1024, 1280 and 1440 |

## Rejected, and why

| Recommendation | Reason |
| --- | --- |
| Red primary #DC2626 / secondary #EF4444 ("recording red") | Product was misclassified as a voice recorder; red clashes with the supplied ClickAI logo (blue to violet) |
| Orange accent #EA580C (colour search) | Not in the brand palette |
| AI purple primary #7C3AED / #6366F1 | Brand direction is electric blue primary with violet only as a restrained secondary |
| Background #F8FAFC / #FAF5FF | Brief asks for warm off-white; `paper` (#faf8f4) used |
| Inter / Inter | Would add a font request and flatten the display/UI contrast; serif + sans achieved with existing fonts |
| Playfair Display / Cormorant / Newsreader | Extra font downloads for little gain over Instrument Serif |
| GSAP `back.out(1.4)` stagger snippet | Brief forbids unnecessary animation dependencies; the bounce overshoot also conflicts with a restrained tone. CSS transitions used |
| `pages/home.md`: max width 800 px, single column | Wrong for a multi-section marketing page; 1200 px container kept |
| "Thumbs up/down / Regenerate", token streaming for AI replies | No backend support; would be a mock |
| Glassmorphism (style search result) | Brief says avoid excessive glassmorphism |

## Vantage Framer template

Not accessible. No screenshot was supplied in this conversation, no browser tab for it was open (`tabs_context` showed only
localhost), and `https://www.framer.com/marketplace/templates/vantage/` returned "Template unavailable". **It was therefore not
inspected and not used.** The editorial grid, mono labels and instrument-style hero were designed from the skill's Swiss/grid style
guidance and general editorial principles, not from that template.
