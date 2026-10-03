/**
 * The orb's placeholder visual — a plain CSS gradient circle, deliberately
 * kept in its own module that never imports the three.js / R3F packages.
 * It's reused in three places that must all render pixel-identical markup
 * so swapping between them never shifts layout: before the orb's section is
 * near the viewport, while the lazy-loaded OrganicOrb chunk is downloading
 * (the Suspense fallback), and inside OrganicOrb itself before its WebGL
 * canvas mounts on the client.
 */
export function OrganicOrbFallback({ className }: { className?: string | undefined }) {
  return (
    <div
      className={className}
      aria-hidden="true"
      style={{
        borderRadius: "9999px",
        background: "radial-gradient(circle at 35% 30%, #93c5fd, #7c3aed 55%, #312e81 100%)",
      }}
    />
  );
}
