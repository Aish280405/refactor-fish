// A deliberately messy order-processing module used as the Refactor_Fish demo target.

export interface LineItem {
  sku: string;
  price: number;
  qty: number;
}

export interface Customer {
  first: string;
  last: string;
  isMember: boolean;
}

export const auditLog: string[] = [];

// Remove_Unused: never called anywhere.
function legacyRound(value: number): number {
  return Math.round(value * 100) / 100;
}

// Remove_Unused (blunder): the initializer has a side effect. Deleting the
// declaration also drops the audit entry that the tests rely on.
const startupAudit = auditLog.push("orders module loaded");

// Simplify_Boolean: if (c) return true; else return false;
export function isBulkOrder(items: LineItem[]): boolean {
  let count = 0;
  for (const item of items) {
    count += item.qty;
  }
  const bulk: boolean = count > 10;
  if (bulk) {
    return true;
  } else {
    return false;
  }
}

// Simplify_Boolean: `=== true` and `!!` on a boolean.
export function discountRate(customer: Customer, items: LineItem[]): number {
  const bulk: boolean = isBulkOrder(items);
  if (customer.isMember === true) {
    return bulk ? 0.15 : 0.1;
  }
  if (!!bulk) {
    return 0.05;
  }
  return 0;
}

// Inline_Variable: `base` is referenced exactly once.
export function lineTotal(item: LineItem): number {
  const base = item.price * item.qty;
  return base;
}

// Guard_Clause: the whole body is wrapped in an if followed by one return.
export function displayName(customer: Customer): string {
  if (customer.first.length > 0) {
    const full = customer.first + " " + customer.last;
    return full.trim();
  }
  return "anonymous";
}

// Extract_Function: five or more consecutive statements in one block.
export function invoiceTotal(items: LineItem[], taxRate: number): number {
  let subtotal = 0;
  for (const item of items) {
    subtotal += lineTotal(item);
  }
  const tax = subtotal * taxRate;
  const shipping = subtotal > 100 ? 0 : 7.5;
  let total = subtotal + tax;
  total = total + shipping;
  return Math.round(total * 100) / 100;
}

export function describeOrder(customer: Customer, items: LineItem[], taxRate: number): string {
  const name = displayName(customer);
  const rate = discountRate(customer, items);
  const gross = invoiceTotal(items, taxRate);
  const net = Math.round(gross * (1 - rate) * 100) / 100;
  return name + ": " + net.toFixed(2);
}

export function recordOrder(customer: Customer, items: LineItem[], taxRate: number): string {
  const line = describeOrder(customer, items, taxRate);
  auditLog.push(line);
  return line;
}
