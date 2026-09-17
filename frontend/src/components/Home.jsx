import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useScroll, useSpring, useTransform } from "framer-motion";
import { fetchProducts } from "../api/products.js";
import CoverflowCarousel from "./CoverflowCarousel.jsx";
import heroVase from "../assets/hero/hero-vase.jpg";
import heroPerfume from "../assets/hero/hero-perfume.jpg";
import heroTote from "../assets/hero/hero-tote.jpg";

// Fixed editorial stills for the hero collage — deliberately not drawn from
// the product catalogue, which is real inventory photography and can't be
// relied on to fill this space attractively. alt text still needs to read
// like a real product description, not a stock-photo caption.
const HERO_COLLAGE = [
  { src: heroVase, alt: "Hand-painted ceramic vase" },
  { src: heroPerfume, alt: "Glass perfume bottle" },
  { src: heroTote, alt: "Canvas tote bag" },
];

const VALUE_PROPS = [
  {
    index: "01",
    title: "Real-time stock updates",
    description: "Inventory updates live as it changes, so what you see on a product page is what's actually available to buy.",
    icon: (
      <>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </>
    ),
  },
  {
    index: "02",
    title: "Secure checkout",
    description: "Every order runs through an authenticated checkout with built-in verification, so a failure never leaves things half-done.",
    icon: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
  {
    index: "03",
    title: "Fast order tracking",
    description: "Follow your order status live from confirmation to delivery, right from your account.",
    icon: (
      <>
        <path d="M3 7h11v9H3z" />
        <path d="M14 10h4l3 3v3h-7z" />
        <circle cx="7.5" cy="18" r="1.5" />
        <circle cx="17.5" cy="18" r="1.5" />
      </>
    ),
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.06 * index, duration: 0.45, ease: "easeOut" },
  }),
};

const wordContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } },
};

const wordItem = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

// Starts once the headline has finished settling (see the delayChildren
// below), not alongside it — the whole point is "words land, then the
// buttons follow", not everything arriving in the same instant.
const ctaContainer = {
  hidden: {},
  visible: { transition: { delayChildren: 0.8, staggerChildren: 0.1 } },
};

const ctaItem = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

// Renders a headline word-by-word rather than as one block — each word is
// its own motion element so they stagger in, instead of the whole line
// fading in at once. mr-[0.25em]/last:mr-0 stands in for the space between
// words, since consecutive JSX elements from .map() don't carry the
// whitespace text nodes a plain string would.
function RevealHeadline({ words, className }) {
  return (
    <h1 className={className}>
      <motion.span initial="hidden" animate="visible" variants={wordContainer} className="inline">
        {words.map((word, index) => (
          <motion.span
            key={index}
            variants={wordItem}
            className={`inline-block mr-[0.25em] last:mr-0 ${word.emphasis ? "italic text-brand-600" : ""}`}
          >
            {word.text}
          </motion.span>
        ))}
      </motion.span>
    </h1>
  );
}

// A camera-style focus pull rather than a directional wipe — each image
// starts slightly oversized and soft, then settles to full sharpness as
// it scales down to rest. Blur and scale are separate transform/filter
// channels from the y-parallax set via style on the same motion.div, so
// they animate independently without conflict.
const focusPull = {
  hidden: { opacity: 0, scale: 1.08, filter: "blur(14px)" },
  visible: (delay = 0) => ({
    opacity: 1,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1], delay },
  }),
};

export default function Home({ user, profile, onNavigate, onSelectProduct, onSignIn }) {
  const [featured, setFeatured] = useState([]);
  const heroRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchProducts({ limit: 8 })
      .then((data) => { if (!cancelled) setFeatured(data.items || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Scroll-linked, not a fixed-duration animation: as the hero scrolls from
  // fully in view (progress 0) to fully past (progress 1), the collage
  // gently zooms and its two halves drift apart at different speeds — real
  // parallax depth rather than one flat photo block.
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const collageScale = useTransform(scrollYProgress, [0, 1], [1, 1.12]);
  const yTall = useTransform(scrollYProgress, [0, 1], [0, -30]);
  const ySmall = useTransform(scrollYProgress, [0, 1], [0, -60]);

  // Cursor-reactive tilt — desktop only, gated on real hover support
  // (matchMedia("hover: hover"), not a viewport-width guess) so a
  // touchscreen never gets a rotation stuck mid-tilt with no mouseleave to
  // reset it. Spring-smoothed so it trails the cursor rather than snapping.
  const [supportsHover] = useState(() => {
    try { return Boolean(window.matchMedia?.("(hover: hover)").matches); }
    catch { return false; }
  });
  const rawRotateX = useMotionValue(0);
  const rawRotateY = useMotionValue(0);
  const rotateX = useSpring(rawRotateX, { stiffness: 150, damping: 20 });
  const rotateY = useSpring(rawRotateY, { stiffness: 150, damping: 20 });

  function handleCollageMouseMove(event) {
    if (!supportsHover) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    rawRotateY.set(px * 8);
    rawRotateX.set(py * -8);
  }
  function handleCollageMouseLeave() {
    rawRotateX.set(0);
    rawRotateY.set(0);
  }

  const headlineWords = user
    ? [{ text: "Welcome" }, { text: `back${profile?.givenName ? `, ${profile.givenName}` : ""}.` }]
    : [{ text: "Good" }, { text: "taste," }, { text: "delivered.", emphasis: true }];

  return (
    <div className="space-y-24 pb-6">
      <section ref={heroRef} className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-600"
          >
            SmartRetailX
          </motion.p>
          <RevealHeadline
            words={headlineWords}
            className="text-balance mt-5 font-serif text-5xl font-medium leading-[1.05] tracking-tight text-stone-900 sm:text-6xl"
          />
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut", delay: 0.55 }}
            className="text-pretty mt-6 max-w-md text-lg leading-relaxed text-stone-600"
          >
            A curated catalogue, real-time stock you can trust, and an order journey you can actually follow — from checkout to your door.
          </motion.p>
          <motion.div initial="hidden" animate="visible" variants={ctaContainer} className="mt-9 flex flex-wrap gap-3">
            <motion.button
              variants={ctaItem}
              onClick={() => onNavigate("catalogue")}
              className="rounded-full bg-brand-600 px-7 py-3.5 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0"
            >
              Shop the collection
            </motion.button>
            {user ? (
              <motion.button
                variants={ctaItem}
                onClick={() => onNavigate("orders")}
                className="rounded-full border border-stone-300 px-7 py-3.5 text-sm font-medium text-stone-700 transition hover:-translate-y-0.5 hover:border-stone-400 hover:bg-white active:translate-y-0"
              >
                Track your orders
              </motion.button>
            ) : (
              <motion.button
                variants={ctaItem}
                onClick={onSignIn}
                className="rounded-full border border-stone-300 px-7 py-3.5 text-sm font-medium text-stone-700 transition hover:-translate-y-0.5 hover:border-stone-400 hover:bg-white active:translate-y-0"
              >
                Sign in
              </motion.button>
            )}
          </motion.div>
        </div>

        <motion.div
          onMouseMove={handleCollageMouseMove}
          onMouseLeave={handleCollageMouseLeave}
          style={{ scale: collageScale, rotateX, rotateY, transformPerspective: 800 }}
          className="grid grid-cols-2 grid-rows-2 gap-4"
        >
          <motion.div
            custom={0.2}
            initial="hidden"
            animate="visible"
            variants={focusPull}
            style={{ y: yTall }}
            className="col-span-1 row-span-2 overflow-hidden rounded-3xl bg-cream-200 shadow-luxe"
          >
            <img src={HERO_COLLAGE[0].src} alt={HERO_COLLAGE[0].alt} className="h-full w-full object-cover" />
          </motion.div>
          <motion.div
            custom={0.35}
            initial="hidden"
            animate="visible"
            variants={focusPull}
            style={{ y: ySmall }}
            className="mt-8 overflow-hidden rounded-2xl bg-cream-200 shadow-luxe-sm"
          >
            <img src={HERO_COLLAGE[1].src} alt={HERO_COLLAGE[1].alt} className="aspect-square w-full object-cover" />
          </motion.div>
          <motion.div
            custom={0.45}
            initial="hidden"
            animate="visible"
            variants={focusPull}
            style={{ y: ySmall }}
            className="overflow-hidden rounded-2xl bg-cream-200 shadow-luxe-sm"
          >
            <img src={HERO_COLLAGE[2].src} alt={HERO_COLLAGE[2].alt} className="aspect-square w-full object-cover" />
          </motion.div>
        </motion.div>
      </section>

      {featured.length > 0 && (
        <section>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-600">New in</p>
              <h2 className="mt-2 font-serif text-3xl font-medium text-stone-900">This week's picks</h2>
            </div>
            <button onClick={() => onNavigate("catalogue")} className="text-sm font-medium text-brand-700 transition hover:text-brand-900">
              Browse full catalogue →
            </button>
          </div>
          <div className="mt-8">
            <CoverflowCarousel products={featured} onSelectProduct={onSelectProduct} autoplay />
          </div>
        </section>
      )}

      <section>
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-600">Why SmartRetailX</p>
        <h2 className="text-balance mt-2 max-w-xl font-serif text-3xl font-medium text-stone-900">Built for a better shopping experience</h2>
        <div className="mt-10 divide-y divide-brand-900/10 border-y border-brand-900/10">
          {VALUE_PROPS.map((item, index) => (
            <motion.div
              key={item.title}
              custom={index}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: false, margin: "-60px" }}
              variants={fadeUp}
              className={`flex flex-col gap-5 py-8 sm:flex-row sm:items-center sm:gap-10 ${index % 2 === 1 ? "sm:flex-row-reverse sm:text-right" : ""}`}
            >
              <span className="font-serif text-5xl font-light italic text-brand-200 sm:w-24 sm:shrink-0">
                {item.index}
              </span>
              <div className={`flex items-start gap-4 sm:flex-1 ${index % 2 === 1 ? "sm:flex-row-reverse" : ""}`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                    {item.icon}
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-stone-900">{item.title}</h3>
                  <p className="mt-1.5 max-w-md leading-relaxed text-stone-600">{item.description}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="bg-grain overflow-hidden rounded-3xl bg-plum px-8 py-14 text-center text-white sm:px-16">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-300">Get in touch</p>
        <h2 className="mt-3 font-serif text-3xl font-medium">We're here to help</h2>
        <p className="mx-auto mt-3 max-w-md text-stone-300">
          Questions about an order or the catalogue? Reach out and we'll get back to you.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm">
          <a href="mailto:support@smartretailx.com" className="font-medium text-white transition hover:text-brand-300">
            support@smartretailx.com
          </a>
          <span className="text-stone-400">Mon–Fri, 9am–6pm</span>
        </div>
      </section>
    </div>
  );
}
