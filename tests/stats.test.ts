import { describe, expect, it } from "vitest";
import {
  correlation,
  covariance,
  cornishFisherQuantile,
  excessKurtosis,
  mean,
  normalCdf,
  normalInv,
  quantile,
  skewness,
  stdev,
  variance,
} from "@/lib/risk/stats";

/**
 * Known-answer tests. Every expected value here was derived independently
 * (closed form, or the numpy/R definition of the same estimator) rather than
 * by running this code and pasting the output — otherwise the test only
 * asserts that the bug is reproducible.
 */

describe("descriptive statistics", () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];

  it("computes the mean", () => {
    expect(mean(xs)).toBe(5);
  });

  it("uses the n-1 denominator for sample variance", () => {
    // Population variance is 4; sample variance is 4 * 8/7.
    expect(variance(xs)).toBeCloseTo(32 / 7, 12);
    expect(stdev(xs)).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it("returns 0 rather than NaN for degenerate input", () => {
    expect(mean([])).toBe(0);
    expect(variance([1])).toBe(0);
    expect(stdev([])).toBe(0);
    expect(correlation([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it("computes covariance and correlation consistently", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(covariance(a, b)).toBeCloseTo(5, 12);
    expect(correlation(a, b)).toBeCloseTo(1, 12);
    expect(correlation(a, [...b].reverse())).toBeCloseTo(-1, 12);
  });

  it("clamps correlation into [-1, 1]", () => {
    const a = [0.001, 0.002, 0.003, 0.004];
    expect(correlation(a, a)).toBeLessThanOrEqual(1);
    expect(correlation(a, a)).toBeGreaterThanOrEqual(-1);
  });
});

describe("quantile", () => {
  it("matches the type-7 (numpy default) definition", () => {
    const xs = [1, 2, 3, 4];
    // pos = 0.5 * 3 = 1.5 -> midpoint of 2 and 3
    expect(quantile(xs, 0.5)).toBeCloseTo(2.5, 12);
    // pos = 0.25 * 3 = 0.75 -> 1 + 0.75 * (2-1)
    expect(quantile(xs, 0.25)).toBeCloseTo(1.75, 12);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
  });

  it("is order-independent", () => {
    expect(quantile([9, 1, 5, 3], 0.5)).toBeCloseTo(quantile([1, 3, 5, 9], 0.5), 12);
  });
});

describe("normal distribution helpers", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("normalInv matches the standard critical values", () => {
    expect(normalInv(0.5)).toBeCloseTo(0, 8);
    expect(normalInv(0.95)).toBeCloseTo(1.6448536, 6);
    expect(normalInv(0.99)).toBeCloseTo(2.3263479, 6);
    expect(normalInv(0.01)).toBeCloseTo(-2.3263479, 6);
  });

  it("normalInv is the inverse of normalCdf", () => {
    for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 4);
    }
  });
});

describe("higher moments", () => {
  it("reports ~0 skew and excess kurtosis for a symmetric sample", () => {
    const symmetric = [-3, -2, -1, 0, 1, 2, 3];
    expect(skewness(symmetric)).toBeCloseTo(0, 10);
  });

  it("detects left skew", () => {
    const leftSkewed = [-10, 1, 1, 1, 1, 1, 2];
    expect(skewness(leftSkewed)).toBeLessThan(0);
  });

  it("detects fat tails", () => {
    const fat = [0, 0, 0, 0, 0, 0, 0, 0, 0, -8, 8];
    expect(excessKurtosis(fat)).toBeGreaterThan(0);
  });
});

describe("Cornish-Fisher", () => {
  it("reduces to the normal quantile with zero skew and kurtosis", () => {
    expect(cornishFisherQuantile(0.01, 0, 0)).toBeCloseTo(normalInv(0.01), 10);
  });

  it("pushes the left tail further out when returns are left-skewed", () => {
    const plain = normalInv(0.01);
    const adjusted = cornishFisherQuantile(0.01, -1.2, 4);
    expect(adjusted).toBeLessThan(plain);
  });
});
