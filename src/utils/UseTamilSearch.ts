/**
 * useTamilSearch.ts
 *
 * Universal React hook for Tamil-aware fuzzy search.
 * Drop this into any page — Products, Customers, Orders, etc.
 *
 * How it works:
 *   When a user types English (e.g. "arisi"), the hook also matches
 *   items whose Tamil name transliterates to that string, so
 *   "அரிசி" shows up when you type "arisi".
 *   Works in both directions: Tamil input matches Tamil data too.
 *
 * Usage:
 *   const { query, setQuery, results } = useTamilSearch(items, ["name", "category"]);
 */

import { useState, useMemo } from "react";
import { transliterate } from "./TamilTransliterator";

function tamilMatch(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const h    = haystack.toLowerCase();
  const n    = needle.toLowerCase();
  const hRom = transliterate(h);
  const nRom = transliterate(n);
  return (
    h.includes(n)       ||
    hRom.includes(nRom) ||
    hRom.includes(n)    ||
    h.includes(nRom)
  );
}

export function useTamilSearch<T extends Record<string, unknown>>(
  items: T[],
  fields: (keyof T)[],
): { query: string; setQuery: (q: string) => void; results: T[] } {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items;
    return items.filter((item) =>
      fields.some((field) => {
        const val = item[field];
        if (typeof val !== "string") return false;
        return tamilMatch(val, trimmed);
      }),
    );
  }, [items, fields, query]);

  return { query, setQuery, results };
}