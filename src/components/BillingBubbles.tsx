import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useBillingDraftsStore } from "../store/billingDraftsStore";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase/config";

// Splits a string into user-perceived characters ("grapheme clusters") rather
// than raw JS string indices — needed because scripts like Tamil build a
// single visible letter from multiple combining code points (e.g. ஸ + ் + ட
// + ோ + ர + ்). Naively slicing name[0] chops a letter apart mid-character
// and renders a broken glyph, which is exactly what showed up in the bubble.
function graphemes(s: string): string[] {
  const IntlAny = Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } };
  if (IntlAny.Segmenter) {
    const seg = new IntlAny.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(seg.segment(s), (x) => x.segment);
  }
  // Fallback for environments without Intl.Segmenter — at least respects
  // surrogate-pair codepoints, though not full grapheme clusters.
  return Array.from(s);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return graphemes(parts[0]).slice(0, 2).join("").toUpperCase();
  const first  = graphemes(parts[0])[0] ?? "";
  const second = graphemes(parts[1])[0] ?? "";
  return (first + second).toUpperCase();
}

function fmtRupees(v: number): string {
  return `₹${Number(v).toFixed(2)}`;
}

const BUBBLE_COLORS = [
  "bg-orange-500", "bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-pink-500",
];

export default function BillingBubbles() {
  const navigate = useNavigate();
  const location = useLocation();
  const drafts = useBillingDraftsStore((s) => s.drafts);
  const activeCustomerId = useBillingDraftsStore((s) => s.activeCustomerId);
  const requestResume = useBillingDraftsStore((s) => s.requestResume);
  const pruneExpired = useBillingDraftsStore((s) => s.pruneExpired);

  const [expiryHours, setExpiryHours] = useState(3);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Load configurable expiry from business settings, then re-prune periodically.
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "settings", "business"))
      .then((snap) => {
        if (cancelled) return;
        const hrs = (snap.data() as { draftBillExpiryHours?: number } | undefined)?.draftBillExpiryHours;
        if (typeof hrs === "number" && hrs > 0) setExpiryHours(hrs);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    pruneExpired(expiryHours);
    const id = setInterval(() => pruneExpired(expiryHours), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [expiryHours, pruneExpired]);

  // Bubbles shown = every saved draft except whichever one is currently open on screen.
  const bubbleDrafts = Object.values(drafts)
    .filter((d) => d.customer.id !== activeCustomerId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (bubbleDrafts.length === 0) return null;

  const handleClick = (customerId: string) => {
    requestResume(customerId);
    if (location.pathname !== "/create-order") navigate("/create-order");
  };

  return (
    <div className="fixed bottom-5 right-5 z-30 flex flex-col-reverse items-end gap-2">
      {bubbleDrafts.map((d, i) => {
        const cid = d.customer.id!;
        const itemCount = Object.values(d.cartQty).reduce((s, q) => s + (q > 0 ? 1 : 0), 0);
        const ageMs = Date.now() - d.updatedAt;
        const staleFrac = ageMs / (expiryHours * 60 * 60 * 1000);
        const isStale = staleFrac >= 0.6; // grey out once 60% of the way to expiry
        const color = BUBBLE_COLORS[i % BUBBLE_COLORS.length];

        return (
          <div
            key={cid}
            className="relative"
            onMouseEnter={() => setHoveredId(cid)}
            onMouseLeave={() => setHoveredId((h) => (h === cid ? null : h))}
          >
            {hoveredId === cid && (
              <div className="absolute bottom-full right-0 mb-2 w-52 bg-gray-900 text-white text-xs rounded-lg shadow-xl p-3 pointer-events-none">
                <p className="font-semibold truncate">{d.customer.shopName}</p>
                <p className="text-gray-300 mt-0.5">
                  {itemCount} item{itemCount === 1 ? "" : "s"}
                  {d.lastKnownTotal > 0 ? ` · ${fmtRupees(d.lastKnownTotal)}` : ""}
                </p>
                <p className="text-gray-400 mt-1">
                  {isStale ? "⚠ Draft is getting stale" : "Tap to resume billing"}
                </p>
              </div>
            )}
            <button
              onClick={() => handleClick(cid)}
              title={`${d.customer.shopName} — tap to resume`}
              className={`w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white font-bold text-sm relative transition-all hover:scale-105 ${
                isStale ? "bg-gray-400" : color
              }`}
            >
              {initials(d.customer.shopName)}
              {itemCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1 border-2 border-white">
                  {itemCount}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
