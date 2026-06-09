import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreRing } from "./score-ring";

describe("ScoreRing", () => {
  it("renders the rounded score", () => {
    render(<ScoreRing score={87.6} />);
    expect(screen.getByText("88")).toBeInTheDocument();
  });

  it("clamps out-of-range scores", () => {
    render(<ScoreRing score={140} />);
    expect(screen.getByText("100")).toBeInTheDocument();
  });
});
