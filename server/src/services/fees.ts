/**
 * Cached fee structure per platform per restaurant.
 * Populated from platform-specific endpoints during menu population:
 *   - DoorDash: from storepageFeed.storeHeader.deliveryFeeLayout + tooltip text
 *   - Seamless: from /restaurants/{id} → restaurant_availability.delivery_fees[]
 *
 * The comparison engine computes the actual fees for a given subtotal using
 * these cached parameters — no live cart simulation required, which avoids
 * the "required modifier category" errors that block live fetch for many items.
 */
export interface CachedFees {
  /** Flat base delivery fee in cents */
  deliveryFeeCents: number;
  /** Decimal rate (e.g. 0.15 for 15%) applied to subtotal */
  serviceFeeRate: number;
  /** Minimum service fee in cents (applied when subtotal * rate < this) */
  serviceFeeMinCents: number;
  /** Maximum service fee in cents (0 = no cap) */
  serviceFeeMaxCents: number;
  /** Flat "other fees" / service toll in cents (SL's SERVICE_TOLL, etc.) */
  serviceTollCents: number;
  /** Small order fee in cents, charged if subtotal < threshold */
  smallOrderFeeCents: number;
  /** Subtotal threshold (cents) below which smallOrderFeeCents applies */
  smallOrderThresholdCents: number;
  /** ISO 8601 timestamp when this data was captured */
  capturedAt: string;
  /** Optional — whether the user's DashPass subscription zeroes delivery on DD */
  dashpassEligible?: boolean;
}

/** Map of platform name to cached fees for a single restaurant. */
export type PlatformFeesMap = Partial<Record<'doordash' | 'seamless', CachedFees>>;

export interface ComputedFees {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  serviceTollCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

const NYC_TAX_RATE = 0.08875;

/**
 * Compute fees for a given subtotal using cached fee structure.
 * Tax is applied to (subtotal + delivery + service + service_toll + small_order)
 * which matches the observed Seamless bill structure in real invoices.
 *
 * If dashpass=true AND the cached fees are DoorDash-shaped, delivery is zeroed
 * and service rate is reduced to 5% (DashPass terms, per DoorDash's fee disclosure).
 */
export function computeFeesFromCache(
  subtotalCents: number,
  fees: CachedFees,
  options: { platform: 'doordash' | 'seamless'; dashpass?: boolean } = { platform: 'seamless' }
): ComputedFees {
  const isDD = options.platform === 'doordash';
  const applyDashpass = isDD && options.dashpass === true;

  // Delivery fee: zero if DashPass is active on DD
  const deliveryFeeCents = applyDashpass ? 0 : fees.deliveryFeeCents;

  // Service fee: rate applied to subtotal, bounded by min/max
  const effectiveRate = applyDashpass ? 0.05 : fees.serviceFeeRate;
  const rawService = Math.round(subtotalCents * effectiveRate);
  let serviceFeeCents = rawService;
  if (fees.serviceFeeMinCents > 0 && serviceFeeCents < fees.serviceFeeMinCents) {
    serviceFeeCents = fees.serviceFeeMinCents;
  }
  if (fees.serviceFeeMaxCents > 0 && serviceFeeCents > fees.serviceFeeMaxCents) {
    serviceFeeCents = fees.serviceFeeMaxCents;
  }

  // Service toll (flat "other fees" that Seamless charges separately)
  const serviceTollCents = fees.serviceTollCents || 0;

  // Small order fee: flat if subtotal below threshold
  const smallOrderFeeCents =
    fees.smallOrderFeeCents > 0 && fees.smallOrderThresholdCents > 0 && subtotalCents < fees.smallOrderThresholdCents
      ? fees.smallOrderFeeCents
      : 0;

  // Tax on the full pre-tax amount (matches observed SL bill structure)
  const taxableBase = subtotalCents + deliveryFeeCents + serviceFeeCents + serviceTollCents + smallOrderFeeCents;
  const taxCents = Math.round(taxableBase * NYC_TAX_RATE);

  const totalCents = taxableBase + taxCents;

  return {
    subtotalCents,
    deliveryFeeCents,
    serviceFeeCents,
    smallOrderFeeCents,
    serviceTollCents,
    taxCents,
    discountCents: 0,
    totalCents,
  };
}

/**
 * Parse a DoorDash fee string like "$1.99 delivery fee" into cents.
 * Returns 0 if parsing fails (caller should fall back to estimates).
 */
export function parseDashFeeDisplay(displayString: string | undefined | null): number {
  if (!displayString) return 0;
  const match = displayString.match(/\$?(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * 100);
}

/**
 * Extract CachedFees from a DoorDash storepageFeed.storeHeader response.
 * Service fee rate is a constant per DoorDash's fee disclosure (15% standard,
 * 5% DashPass). Small order fee isn't in the storepageFeed response — we use
 * DoorDash's typical pattern (order < $10 → $2 small order fee).
 */
export function extractDoorDashFees(storeHeader: {
  deliveryFeeLayout?: { title?: string | null; displayDeliveryFee?: string | null } | null;
}): CachedFees | null {
  const dfl = storeHeader?.deliveryFeeLayout;
  if (!dfl) return null;
  const displayStr = dfl.displayDeliveryFee || dfl.title || '';
  const deliveryCents = parseDashFeeDisplay(displayStr);
  if (deliveryCents === 0 && !displayStr) return null;

  return {
    deliveryFeeCents: deliveryCents,
    serviceFeeRate: 0.15,       // DD's standard 15% per fee disclosure
    serviceFeeMinCents: 0,      // DD doesn't publish a min in storepageFeed
    serviceFeeMaxCents: 0,
    serviceTollCents: 0,
    smallOrderFeeCents: 200,    // DD typical $2 small order fee
    smallOrderThresholdCents: 1000,  // applies when subtotal < $10
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Extract CachedFees from a Seamless /restaurants/{id} response.
 * The delivery_fees array contains separate entries by fee_name:
 *   DELIVERY (flat), DRIVER_BENEFITS_FEE (flat), SERVICE (percent),
 *   SMALL (flat, conditional), SERVICE_TOLL (flat, sometimes under a
 *   different shape).
 */
export function extractSeamlessFees(restaurantAvailability: any): CachedFees | null {
  const deliveryFees: any[] = restaurantAvailability?.delivery_fees;
  if (!Array.isArray(deliveryFees)) return null;

  const byName: Record<string, any> = {};
  for (const fee of deliveryFees) {
    if (fee?.fee_name) byName[fee.fee_name] = fee;
  }

  // Delivery = DELIVERY + DRIVER_BENEFITS_FEE (both flat)
  const baseDelivery = (byName.DELIVERY?.amount ?? 0) + (byName.DRIVER_BENEFITS_FEE?.amount ?? 0);

  // Service = SERVICE fee (percent with min/max)
  const serviceFee = byName.SERVICE;
  let serviceRate = 0;
  let serviceMin = 0;
  let serviceMax = 0;
  if (serviceFee && serviceFee.operand === 'PERCENT') {
    // amount is stored as basis points / 100 (e.g. 1500 = 15.00%)
    serviceRate = (serviceFee.amount ?? 0) / 10000;
    serviceMin = serviceFee.adjustment?.minimum_amount_for_percentage ?? 0;
    serviceMax = serviceFee.adjustment?.maximum_amount_for_percentage ?? 0;
  } else if (serviceFee && serviceFee.operand === 'FLAT') {
    // Flat service fee — treat as min = max = amount
    serviceMin = serviceFee.amount ?? 0;
    serviceMax = serviceFee.amount ?? 0;
  }

  // Service toll (flat "Other fees" — $2 observed on real bills). Sometimes at
  // restaurant_availability.service_toll_fee.fee.amount rather than in the array.
  const tollFromArray = byName.SERVICE_TOLL?.amount ?? byName.TOLL?.amount ?? 0;
  const tollFromField = restaurantAvailability?.service_toll_fee?.fee?.amount ?? 0;
  const serviceTollCents = tollFromArray || tollFromField || 0;

  // Small order fee
  const smallFee = byName.SMALL;
  const smallOrderFeeCents = smallFee?.amount ?? 0;
  const smallOrderThresholdCents = smallFee?.threshold?.threshold ?? restaurantAvailability?.small_order_fee?.minimum_order_value_cents ?? 0;

  return {
    deliveryFeeCents: baseDelivery,
    serviceFeeRate: serviceRate,
    serviceFeeMinCents: serviceMin,
    serviceFeeMaxCents: serviceMax,
    serviceTollCents,
    smallOrderFeeCents,
    smallOrderThresholdCents,
    capturedAt: new Date().toISOString(),
  };
}
