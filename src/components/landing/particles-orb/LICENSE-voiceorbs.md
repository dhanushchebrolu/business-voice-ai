# Attribution

`orb-state.ts`, `orb-color.ts`, `use-reduced-motion.ts`, `use-in-view.ts`,
`use-orb-animator.ts`, and `particles-orb.tsx` in this directory are adapted
from the **Particles Orb** component of [VoiceOrbs](https://voiceorbs.vercel.app/orbs/particles-orb)
([github.com/amunozdev/voiceorbs](https://github.com/amunozdev/voiceorbs)),
used under the MIT License below. `particles-orb-fallback.tsx` and `index.ts`
are original to this project.

Changes made: default `colorFrom`/`colorTo` recolored from VoiceOrbs' pink/
purple to ClickAI's violet/indigo/cyan palette; `orb-color.ts`'s internal
import of `orb-state` has an explicit `.ts` extension (needed for this
repo's tests to import it directly under plain `node --test`; Vite resolves
it identically either way). Otherwise the particle formation, state
machine, and canvas rendering are unmodified from source.

---

MIT License

Copyright (c) 2026 Alexis Munoz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
