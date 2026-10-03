/**
 * One animated connector in the hero flow diagram: a gradient-stroked SVG
 * path plus (a) a dashed overlay whose stroke-dashoffset animates
 * continuously for a "flowing light" look along the wire, and (b) small
 * glowing particles that travel the exact curve via native SVG
 * <animateMotion><mpath>, not an approximated left/right translate — the
 * particle's position is defined by the path itself, so it always follows
 * the real curve regardless of how the path is reshaped per breakpoint.
 *
 * `reduced` strips the animated overlay and particles entirely (React
 * never mounts them) so a prefers-reduced-motion visitor gets the static
 * gradient wire with no moving parts, per the project's established
 * usePrefersReducedMotion contract (see particle-wave.tsx for precedent).
 */
export interface FlowWireProps {
  id: string;
  d: string;
  reduced: boolean;
  duration?: number;
  delay?: number;
  particleCount?: number;
  strokeWidth?: number;
}

export function FlowWire({
  id,
  d,
  reduced,
  duration = 3.6,
  delay = 0,
  particleCount = 1,
  strokeWidth = 2,
}: FlowWireProps) {
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="url(#hero-flow-gradient)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        opacity={0.5}
      />
      {!reduced && (
        <path
          id={id}
          d={d}
          fill="none"
          stroke="url(#hero-flow-gradient)"
          strokeWidth={strokeWidth + 0.5}
          strokeLinecap="round"
          strokeDasharray="14 160"
          className="hero-flow-dash"
          style={{ animationDuration: `${duration * 1.8}s`, animationDelay: `${delay}s` }}
        />
      )}
      {!reduced &&
        Array.from({ length: particleCount }, (_, i) => (
          <circle key={i} r={3.2} fill="url(#hero-flow-particle)" filter="url(#hero-flow-glow)">
            <animateMotion
              dur={`${duration}s`}
              begin={`${delay + (i * duration) / particleCount}s`}
              repeatCount="indefinite"
            >
              <mpath href={`#${id}`} xlinkHref={`#${id}`} />
            </animateMotion>
          </circle>
        ))}
    </g>
  );
}
