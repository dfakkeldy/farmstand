import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney, roundCash } from "../src/money";

describe("roundCash (Canadian 5-cent rule)", () => {
  it.each([
    [1390, 1390],
    [1391, 1390],
    [1392, 1390],
    [1393, 1395],
    [1394, 1395],
    [1395, 1395],
    [1396, 1395],
    [1397, 1395],
    [1398, 1400],
    [1399, 1400],
  ])("%i cents -> %i cents", (input, expected) => {
    expect(roundCash(input, 5)).toBe(expected);
  });

  it("step 1 leaves the amount alone", () => {
    expect(roundCash(1398, 1)).toBe(1398);
  });
});

describe("formatMoney", () => {
  it("formats dollars and cents", () => {
    expect(formatMoney(1400)).toBe("$14.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(-200)).toBe("-$2.00");
  });
});

describe("parseMoney", () => {
  it.each([
    ["35", 3500],
    ["35.5", 3550],
    ["$35.50", 3550],
    [" 0.05 ", 5],
    ["1,234.50", 123450],
  ])("%s -> %i", (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "-5", "3.5.0"])("rejects %s", (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});
