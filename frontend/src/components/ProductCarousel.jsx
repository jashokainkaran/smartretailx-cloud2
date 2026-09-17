import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import { motion } from "framer-motion";
import ProductImage from "./ProductImage.jsx";
import { formatPrice } from "../lib/currency.js";

function ChevronIcon({ direction }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d={direction === "prev" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

// A swipeable strip rather than a fixed grid — deliberately no dot
// indicators: the next card peeking in at the edge already signals "there's
// more" without the generic carousel-dots look. Reused by both Home's
// "This week's picks" (autoplay) and the "Recently viewed" strip (swipe
// only — a shorter, personal list doesn't need to move on its own).
//
// autoplay is opt-in per instance, not a global default: the Autoplay
// plugin instance is created once via useState's lazy initializer rather
// than inline in the hook call, so a re-render doesn't hand Embla a new
// plugin reference and force an unnecessary reinit. stopOnInteraction:false
// is the actual "safety valve" — any drag/hover pauses it, then it resumes
// on its own rather than stopping for good the first time someone touches it.
export default function ProductCarousel({ products, onSelectProduct, autoplay = false }) {
  const [plugins] = useState(() => (autoplay ? [Autoplay({ delay: 4000, stopOnInteraction: false, stopOnMouseEnter: true })] : []));
  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "start", dragFree: true, containScroll: "trimSnaps", loop: autoplay }, plugins);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const updateButtons = useCallback(() => {
    if (!emblaApi) return;
    setCanPrev(emblaApi.canScrollPrev());
    setCanNext(emblaApi.canScrollNext());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return undefined;
    updateButtons();
    emblaApi.on("select", updateButtons);
    emblaApi.on("reInit", updateButtons);
    return () => { emblaApi.off("select", updateButtons); emblaApi.off("reInit", updateButtons); };
  }, [emblaApi, updateButtons]);

  return (
    <div className="relative">
      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-5">
          {products.map((product) => (
            <button
              key={product.id}
              onClick={() => onSelectProduct(product.id)}
              className="group w-[45%] shrink-0 text-left sm:w-[27%] lg:w-[22%]"
            >
              <motion.div
                layoutId={`product-image-${product.id}`}
                transition={{ layout: { type: "spring", stiffness: 300, damping: 32 } }}
                className="aspect-square overflow-hidden rounded-2xl bg-cream-200"
              >
                <ProductImage
                  src={product.image_url}
                  alt={product.name}
                  className="h-full w-full object-cover transition duration-500 ease-out group-hover:scale-105"
                />
              </motion.div>
              <p className="mt-3 truncate font-medium text-stone-900">{product.name}</p>
              <p className="text-sm text-stone-500">{formatPrice(product.price)}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="hidden sm:block">
        <button
          onClick={() => emblaApi?.scrollPrev()}
          disabled={!canPrev}
          aria-label="Previous products"
          className="absolute -left-4 top-[38%] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white text-stone-700 shadow-luxe-sm transition hover:-translate-x-0.5 disabled:cursor-not-allowed disabled:opacity-0"
        >
          <ChevronIcon direction="prev" />
        </button>
        <button
          onClick={() => emblaApi?.scrollNext()}
          disabled={!canNext}
          aria-label="Next products"
          className="absolute -right-4 top-[38%] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white text-stone-700 shadow-luxe-sm transition hover:translate-x-0.5 disabled:cursor-not-allowed disabled:opacity-0"
        >
          <ChevronIcon direction="next" />
        </button>
      </div>
    </div>
  );
}
