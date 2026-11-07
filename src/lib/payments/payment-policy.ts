/**
 * When a new booking must be paid for before it is confirmed — one rule for
 * every channel (WhatsApp actions and the LiveKit voice agent's session
 * tools): the service has a price above zero AND the business enabled both
 * payment-required bookings and payment requests. The amount is always the
 * service's own configured price, never a model's or a caller's figure.
 * Pure (no I/O).
 */
export function bookingNeedsPayment(
  service: { price: number | null } | null,
  caps: Record<string, unknown>,
): boolean {
  return (
    service !== null &&
    (service.price ?? 0) > 0 &&
    caps["booking_payment_required"] === true &&
    caps["payment_request"] === true
  );
}

/** The service price in the currency's smallest unit (₹500 -> 50000 paise). */
export function paymentAmountMinorUnits(price: number): number {
  return Math.round(price * 100);
}
