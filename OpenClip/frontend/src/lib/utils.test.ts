import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, scoreColor } from "./utils";

describe("formatDuration", () => {
  it("formats sub-hour durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(599)).toBe("9:59");
  });

  it("formats hour+ durations as h:mm:ss", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("guards against nullish/negative values", () => {
    expect(formatDuration(null)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
  });
});

describe("scoreColor", () => {
  it("buckets by threshold", () => {
    expect(scoreColor(90)).toContain("emerald");
    expect(scoreColor(65)).toContain("amber");
    expect(scoreColor(45)).toContain("orange");
    expect(scoreColor(10)).toContain("rose");
  });
});
