import { useState } from "react";
import ImagePlaceholder from "./ImagePlaceholder.jsx";

// Centralises the "show the real image, or a placeholder" choice so every
// call site gets a graceful fallback on a broken URL too, not just a missing
// one — a bad image_url (e.g. a link to a webpage instead of an image file)
// would otherwise render the browser's broken-image icon forever.
export default function ProductImage({ src, alt = "", className = "" }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return <ImagePlaceholder className={className} />;

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
