import { describe, expect, it } from "vitest";
import {
  auditLog,
  describeOrder,
  discountRate,
  displayName,
  invoiceTotal,
  isBulkOrder,
  lineTotal,
  recordOrder,
} from "./orders";

const member = { first: "Ada", last: "Lovelace", isMember: true };
const guest = { first: "", last: "", isMember: false };
const few = [{ sku: "a", price: 10, qty: 2 }];
const many = [{ sku: "b", price: 20, qty: 12 }];

describe("orders", () => {
  it("records module load in the audit log", () => {
    expect(auditLog[0]).toBe("orders module loaded");
  });

  it("detects bulk orders", () => {
    expect(isBulkOrder(few)).toBe(false);
    expect(isBulkOrder(many)).toBe(true);
  });

  it("computes discount rates", () => {
    expect(discountRate(member, few)).toBe(0.1);
    expect(discountRate(member, many)).toBe(0.15);
    expect(discountRate(guest, many)).toBe(0.05);
    expect(discountRate(guest, few)).toBe(0);
  });

  it("computes line totals", () => {
    expect(lineTotal(few[0])).toBe(20);
  });

  it("formats display names", () => {
    expect(displayName(member)).toBe("Ada Lovelace");
    expect(displayName(guest)).toBe("anonymous");
  });

  it("computes invoice totals", () => {
    expect(invoiceTotal(few, 0.1)).toBe(29.5);
    expect(invoiceTotal(many, 0.1)).toBe(264);
  });

  it("describes and records orders", () => {
    expect(describeOrder(member, few, 0.1)).toBe("Ada Lovelace: 26.55");
    expect(recordOrder(guest, many, 0.1)).toBe("anonymous: 250.80");
    expect(auditLog).toContain("anonymous: 250.80");
  });
});
