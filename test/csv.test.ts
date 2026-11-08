import { describe, expect, it } from "vitest";
import { cell, csv } from "../src/csv";

describe("csv", () => {
  it.each([
    ["=HYPERLINK(\"x\")", `"'=HYPERLINK(""x"")"`],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["-1+cmd|' /C calc'!A0", "'-1+cmd|' /C calc'!A0"],
    ["+A1", "'+A1"],
    ["+1-902-555-0100", "'+1-902-555-0100"],
    ["+1 902 555 0100", "'+1 902 555 0100"],
  ])("defuses %s", (input, expected) => {
    expect(cell(input)).toBe(expected);
  });

  it.each(["-$2.00", "-3", "$14.00", "(902) 555-0100", "902-555-0100", "12"])("leaves plain values alone: %s", (input) => {
    expect(cell(input)).toBe(input);
  });

  it("quotes a negative amount with a comma but adds no apostrophe", () => {
    expect(cell("-1,250.50")).toBe('"-1,250.50"');
  });

  it("quotes commas, quotes and new lines", () => {
    expect(csv([["a,b", 'say "hi"', "two\nlines"]])).toBe(`"a,b","say ""hi""","two\nlines"\r\n`);
  });
});
