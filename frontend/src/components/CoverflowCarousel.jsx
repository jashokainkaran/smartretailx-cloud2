import { useCallback, useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import ProductImage from "./ProductImage.jsx";
import { formatPrice } from "../lib/currency.js";

const SCALE_MIN = 0.7;
const OPACITY_MIN = 0.55;
const LIFT_PX = 42;

function ChevronIcon({ direction }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d={direction === "prev" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

// Distance is computed from Embla's own public API (scrollProgress +
// scrollSnapList) rather than its undocumented internals — diff is
// wrapped to the shortest signed distance in normalized scroll-space so
// looping doesn't produce a visible snap/jump right at the seam.
function distanceFromCenter(emblaApi, snapIndex) {
  const progress = emblaApi.scrollProgress();
  const snap = emblaApi.scrollSnapList()[snapIndex];
  let diff = snap - progress;
  diff -= Math.round(diff);
  return diff * emblaApi.scrollSnapList().length;
}

// The centred item peaks in size, with neighbours shrinking and dropping
// away on a curve — 3 items emphasised on mobile, 5 on desktop, via the
// basis widths below. Loop is always on, so prev/next never disable.
export default function CoverflowCarousel({ products, onSelectProduct, autoplay = true }) {
  const [plugins] = useState(() => (autoplay ? [Autoplay({ delay: 4000, stopOnInteraction: false, stopOnMouseEnter: true })] : []));
  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "center", loop: true, skipSnaps: false }, plugins);
  const slideRefs = useRef([]);

  // Runs on every 'scroll' frame Embla fires — both while dragging and
  // during its own post-release snap animation — so the tween tracks the
  // real scroll position instead of re-animating on top of it. A CSS
  // transition on transform here would fight that and feel laggy.
  const tween = useCallback(() => {
    if (!emblaApi) return;
    emblaApi.scrollSnapList().forEach((_, index) => {
      const node = slideRefs.current[index];
      if (!node) return;
      const distance = distanceFromCenter(emblaApi, index);
      const abs = Math.min(Math.abs(distance), 2.4);
      const scale = Math.max(SCALE_MIN, 1 - abs * 0.16);
      const opacity = Math.max(OPACITY_MIN, 1 - abs * 0.22);
      const translateY = Math.min(abs, 2) * LIFT_PX;
      node.style.transform = `translateY(${translateY}px) scale(${scale})`;
      node.style.opacity = String(opacity);
      node.style.zIndex = String(Math.round((1 - abs) * 10));
    });
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return undefined;
    tween();
    emblaApi.on("scroll", tween);
    emblaApi.on("reInit", tween);
    return () => { emblaApi.off("scroll", tween); emblaApi.off("reInit", tween); };
  }, [emblaApi, tween]);

  return (
    <div className="relative">
      <div className="overflow-hidden py-6" ref={emblaRef}>
        <div className="flex">
          {products.map((product, index) => (
            <div
              key={product.id}
              ref={(node) => { slideRefs.current[index] = node; }}
              className="shrink-0 basis-[68%] px-2 will-change-transform sm:basis-[42%] lg:basis-1/5"
            >
              <button onClick={() => onSelectProduct(product.id)} className="group block w-full text-left">
                <div className="aspect-square overflow-hidden rounded-2xl bg-cream-200 shadow-luxe-sm">
                  <ProductImage src={product.image_url} alt={product.name} className="h-full w-full object-cover transition duration-500 ease-out group-hover:scale-105" />
                </div>
                <p className="mt-3 truncate font-medium text-stone-900">{product.name}</p>
                <p className="text-sm text-stone-500">{formatPrice(product.price)}</p>
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="hidden sm:block">
        <button
          onClick={() => emblaApi?.scrollPrev()}
          aria-label="Previous products"
          className="absolute -left-4 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white text-stone-700 shadow-luxe-sm transition hover:-translate-x-0.5"
        >
          <ChevronIcon direction="prev" />
        </button>
        <button
          onClick={() => emblaApi?.scrollNext()}
          aria-label="Next products"
          className="absolute -right-4 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white text-stone-700 shadow-luxe-sm transition hover:translate-x-0.5"
        >
          <ChevronIcon direction="next" />
        </button>
      </div>
    </div>
  );
}
