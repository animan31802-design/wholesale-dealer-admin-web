import { Badge } from "./ui";
import { formatRupees, type SubscriptionInfo } from "../../lib/subscription";
import type { PaymentRequest } from "../../types/subscription";

export function statusBadge(info: SubscriptionInfo) {
  switch (info.status) {
    case "active":
      return <Badge tone="green">Active</Badge>;
    case "expiring":
      return <Badge tone="amber">Ending soon</Badge>;
    case "grace":
      return <Badge tone="red">Grace period</Badge>;
    case "expired":
      return <Badge tone="red">Expired · read-only</Badge>;
    case "pending":
      return <Badge tone="blue">Pending activation</Badge>;
    default:
      return <Badge>Not started</Badge>;
  }
}

export function requestStatusBadge(status: PaymentRequest["status"]) {
  if (status === "approved") return <Badge tone="green">Approved</Badge>;
  if (status === "rejected") return <Badge tone="red">Rejected</Badge>;
  if (status === "cancelled") return <Badge>Cancelled</Badge>;
  return <Badge tone="amber">Awaiting verification</Badge>;
}

export function paymentAlertText(req: PaymentRequest): string {
  return [
    "Subscription payment submitted",
    `Business: ${req.tenantName}`,
    `Plan: ${req.planName} (${req.months} month${req.months === 1 ? "" : "s"})`,
    `Amount: ${formatRupees(req.amount)}`,
    `UTR: ${req.utr ?? "not entered"}`,
    `Submitted by: ${req.submittedByName}`,
  ].join("\n");
}
