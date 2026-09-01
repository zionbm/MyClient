import { Prisma, type PaymentStatus } from "@prisma/client";

export function money(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value).toDecimalPlaces(2);
}

export function paymentStatus(total: Prisma.Decimal, paid: Prisma.Decimal): PaymentStatus {
  if (paid.isZero()) return "UNPAID";
  return paid.equals(total) ? "PAID" : "PARTIALLY_PAID";
}

export function nextPaidAmount(
  mode: "ADD" | "SET_PAID_TOTAL" | "SETTLE_BALANCE",
  currentPaid: Prisma.Decimal,
  total: Prisma.Decimal,
  amount?: number
) {
  if (mode === "SETTLE_BALANCE") return total;
  const parsed = money(amount ?? 0);
  return mode === "ADD" ? currentPaid.plus(parsed) : parsed;
}

export function assertAmountInvariant(total: Prisma.Decimal, paid: Prisma.Decimal) {
  if (total.isNegative() || paid.isNegative() || paid.greaterThan(total)) {
    throw new Error("INVALID_AMOUNT_INVARIANT");
  }
}

export function activityStatusAfterAmount(
  currentStatus: "OPEN" | "CLOSED" | "CANCELLED",
  executionCompletedAt: Date | null,
  amountStatus: PaymentStatus
) {
  if (currentStatus === "CANCELLED") return "CANCELLED" as const;
  return executionCompletedAt && amountStatus === "PAID" ? "CLOSED" as const : "OPEN" as const;
}
