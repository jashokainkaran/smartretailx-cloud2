import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ProductImage from "./ProductImage.jsx";

// This is a direct regression test for a real bug found live this session:
// a product's image_url pointed at a stockcake.com webpage, not an image
// file, and every <img> in the app rendered a permanent broken-image icon
// with no fallback. ProductImage.jsx was the fix.
describe("ProductImage", () => {
  it("renders the real image when a working src is given", () => {
    render(<ProductImage src="https://example.com/widget.jpg" alt="Widget" />);
    expect(screen.getByRole("img", { name: "Widget" })).toBeInTheDocument();
  });

  it("shows the placeholder instead of a broken <img> when no src is given", () => {
    render(<ProductImage src={null} alt="Widget" />);
    expect(screen.queryByRole("img", { name: "Widget" })).not.toBeInTheDocument();
  });

  it("falls back to the placeholder once the image actually fails to load", () => {
    render(<ProductImage src="https://example.com/broken.jpg" alt="Widget" />);
    const img = screen.getByRole("img", { name: "Widget" });

    fireEvent.error(img);

    // The broken <img> is gone entirely, replaced by the placeholder —
    // not just visually hidden.
    expect(screen.queryByRole("img", { name: "Widget" })).not.toBeInTheDocument();
  });
});
