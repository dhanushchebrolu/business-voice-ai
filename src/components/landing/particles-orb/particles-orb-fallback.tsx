/**
 * The orb's placeholder visual — a plain CSS gradient circle in the same
 * sky/violet tones as ParticlesOrb's default palette, kept in its own
 * module with no dependency on the canvas component, so it can be shown
 * before the orb's section is near the viewport and as the Suspense
 * fallback while the lazy-loaded chunk downloads, with zero layout shift
 * between either state and the real canvas.
 */
export function ParticlesOrbFallback({ className }: { className?: string | undefined }) {
  return (
    <div
      className={className}
      aria-hidden="true"
      style={{
        borderRadius: "9999px",
        background: "radial-gradient(circle at 35% 30%, #7dd3fc, #7c3aed 65%, #4c1d95 100%)",
      }}
    />
  );
}
