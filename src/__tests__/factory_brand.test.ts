// @vitest-environment node
/**
 * factory_brand.test.ts — PR #7
 * Unit tests for brand CSS generation utilities.
 */

import { describe, it, expect } from "vitest";
import { hexToHsl, buildBrandCss } from "../ipc/handlers/factory_brand";

// =============================================================================
// hexToHsl
// =============================================================================

describe("hexToHsl", () => {
  it("converts pure red (#ff0000) to hsl(0, 100, 50)", () => {
    const { h, s, l } = hexToHsl("#ff0000");
    expect(h).toBe(0);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  it("converts pure green (#00ff00) to hsl(120, 100, 50)", () => {
    const { h, s, l } = hexToHsl("#00ff00");
    expect(h).toBe(120);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  it("converts pure blue (#0000ff) to hsl(240, 100, 50)", () => {
    const { h, s, l } = hexToHsl("#0000ff");
    expect(h).toBe(240);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  it("converts white (#ffffff) to hsl(0, 0, 100)", () => {
    const { h, s, l } = hexToHsl("#ffffff");
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(100);
  });

  it("converts black (#000000) to hsl(0, 0, 0)", () => {
    const { h, s, l } = hexToHsl("#000000");
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(l).toBe(0);
  });

  it("handles 6-digit hex without leading #", () => {
    const { h, s, l } = hexToHsl("4F46E5");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(360);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(l).toBeGreaterThanOrEqual(0);
  });

  it("handles 3-digit shorthand (#f00 == #ff0000)", () => {
    const full = hexToHsl("#ff0000");
    const short = hexToHsl("#f00");
    expect(short.h).toBe(full.h);
    expect(short.s).toBe(full.s);
    expect(short.l).toBe(full.l);
  });

  it("is case-insensitive (#FF0000 == #ff0000)", () => {
    const lower = hexToHsl("#ff0000");
    const upper = hexToHsl("#FF0000");
    expect(upper.h).toBe(lower.h);
    expect(upper.s).toBe(lower.s);
    expect(upper.l).toBe(lower.l);
  });

  it("throws on invalid input", () => {
    expect(() => hexToHsl("not-a-color")).toThrow("Invalid hex color");
    expect(() => hexToHsl("#xyz")).toThrow("Invalid hex color");
    expect(() => hexToHsl("")).toThrow("Invalid hex color");
    expect(() => hexToHsl("#12345")).toThrow("Invalid hex color");
  });

  it("indigo #4F46E5: hue ~243, high saturation, medium-low lightness", () => {
    const { h, s, l } = hexToHsl("#4F46E5");
    expect(h).toBeGreaterThanOrEqual(235);
    expect(h).toBeLessThanOrEqual(250);
    expect(s).toBeGreaterThanOrEqual(60);
    expect(l).toBeGreaterThanOrEqual(30);
    expect(l).toBeLessThanOrEqual(65);
  });
});

// =============================================================================
// buildBrandCss
// =============================================================================

describe("buildBrandCss", () => {
  it("returns a non-empty string", () => {
    expect(buildBrandCss("#4F46E5").length).toBeGreaterThan(0);
  });

  it("includes the DYAD:BRAND_CSS marker", () => {
    expect(buildBrandCss("#4F46E5")).toContain("DYAD:BRAND_CSS");
  });

  it("contains @layer base block", () => {
    const css = buildBrandCss("#4F46E5");
    expect(css).toContain("@layer base");
    expect(css).toContain(":root");
    expect(css).toContain(".dark");
  });

  it("injects --primary CSS variable", () => {
    expect(buildBrandCss("#4F46E5")).toContain("--primary:");
  });

  it("injects --ring CSS variable", () => {
    expect(buildBrandCss("#4F46E5")).toContain("--ring:");
  });

  it("injects --primary-foreground CSS variable", () => {
    expect(buildBrandCss("#4F46E5")).toContain("--primary-foreground:");
  });

  it("uses white foreground for a dark primary (#1a1a2e, l ~14)", () => {
    const css = buildBrandCss("#1a1a2e");
    // light-mode fg should be "210 40% 98%" (near-white) because l < 60
    expect(css).toContain("210 40% 98%");
  });

  it("uses dark foreground for a light primary (#fde68a, l ~76)", () => {
    const css = buildBrandCss("#fde68a");
    // light-mode fg should be "222 47% 11%" (near-black) because l >= 60
    expect(css).toContain("222 47% 11%");
  });

  it("dark-mode primary lightness is >= light-mode lightness (unless already bright)", () => {
    // For a mid-range primary, dark mode should be lighter
    const css = buildBrandCss("#4F46E5"); // l ~55
    // The dark .dark block should have a higher lightness value
    const darkMatch = css.match(
      /\.dark\s*\{[^}]*--primary:\s*(\d+)\s+(\d+)%\s+(\d+)%/,
    );
    expect(darkMatch).not.toBeNull();
    if (darkMatch) {
      const darkL = parseInt(darkMatch[3], 10);
      expect(darkL).toBeGreaterThanOrEqual(55);
      expect(darkL).toBeLessThanOrEqual(85);
    }
  });

  it("is deterministic — same input always produces same output", () => {
    const a = buildBrandCss("#7C3AED");
    const b = buildBrandCss("#7C3AED");
    expect(a).toBe(b);
  });

  it("produces different CSS for different brand colors", () => {
    expect(buildBrandCss("#4F46E5")).not.toBe(buildBrandCss("#059669"));
  });

  it("handles hex without leading #", () => {
    const withHash = buildBrandCss("#4F46E5");
    const withoutHash = buildBrandCss("4F46E5");
    expect(withHash).toBe(withoutHash);
  });
});
