/**
 * Harness only: stand-ins for the signed-in user, checkout, the billing
 * bypass flag and the router Link, so the real AccountStatusPanel renders
 * without auth, payments or a router. Billing is "bypassed" as in staging.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";

export function useAuth() {
  return { user: { id: "user_demo", email: "owner@demo.example" }, session: null, loading: false };
}
export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useCheckout() {
  return { pay: async () => undefined, pending: null };
}
export async function getBillingBypassStatus() {
  return { bypassed: true };
}
export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}
