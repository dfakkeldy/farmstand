export type StandMode = "staffed" | "unattended";

export interface Seller {
  id: number;
  name: string;
  active: number;
  created_at: number;
}

export interface Stand {
  id: number;
  seller_id: number;
  slug: string;
  name: string;
  mode: StandMode;
  pickup_info: string;
  message: string;
  max_per_item: number;
  turnstile_on: number;
  paused: number;
  last_counted_at: number | null;
  active: number;
  created_at: number;
}

export interface Item {
  id: number;
  stand_id: number;
  name: string;
  unit_label: string;
  price_cents: number;
  stock: number;
  held: number;
  short_since_visit: number;
  sold_out: number;
  active: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export type OrderStatus = "placed" | "ready" | "picked_up" | "released" | "cancelled" | "not_found";
export type ClosedBy = "seller" | "customer" | "visit";

export interface Order {
  id: number;
  stand_id: number;
  code: string;
  public_token: string;
  idem_key: string;
  customer_name: string;
  contact: string | null;
  when_note: string | null;
  status: OrderStatus;
  prev_status: OrderStatus | null;
  to_unpack: number;
  reopen_ok: number;
  total_cents: number;
  cash_cents: number;
  orig_total_cents: number;
  orig_cash_cents: number;
  reported_paid_cents: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closed_by: ClosedBy | null;
  scrubbed_at: number | null;
}

export interface OrderLine {
  order_id: number;
  item_id: number;
  item_name: string;
  unit_label: string;
  price_cents: number;
  qty: number;
  packed_qty: number | null;
}

export interface Visit {
  id: number;
  stand_id: number;
  visit_key: string;
  at: number;
  walkin_cents: number;
  app_cash_cents: number;
  expected_cents: number;
  cash_counted_cents: number | null;
  note: string;
}

export interface VisitLineRow {
  visit_id: number;
  item_id: number;
  item_name: string;
  price_cents: number;
  stock_before: number;
  in_baskets: number;
  counted: number | null;
  short_since_visit: number;
  walk_in_sold: number;
  found_more: number;
  removed: number;
  restocked: number;
}

export const OPEN: readonly OrderStatus[] = ["placed", "ready"];

/** Units an order line holds: what was packed, or what was asked for if not packed yet. */
export function units(line: Pick<OrderLine, "qty" | "packed_qty">): number {
  return line.packed_qty ?? line.qty;
}
