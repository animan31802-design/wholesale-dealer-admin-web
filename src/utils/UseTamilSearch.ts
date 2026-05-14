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
import { transliterate, containsTamil } from "./Tamiltransliterator";

/**
 * Checks if `haystack` matches `needle` using Tamil-aware comparison.
 * Tries four combinations so both Tamil↔English and English↔Tamil work.
 */
function tamilMatch(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;

  const h     = haystack.toLowerCase();
  const n     = needle.toLowerCase();
  const hRom  = transliterate(h);
  const nRom  = transliterate(n);

  return (
    h.includes(n)       ||  // "அரிசி".includes("அரி")
    hRom.includes(nRom) ||  // "arisi".includes("ari")
    hRom.includes(n)    ||  // "arisi".includes("ari")  (user typed English)
    h.includes(nRom)        // "அரிசி".includes("arisi") edge case
  );
}

/**
 * Generic Tamil-aware search hook.
 *
 * @param items   - Full list of objects to search through.
 * @param fields  - Object keys to search within (e.g. ["name", "category"]).
 * @returns       - { query, setQuery, results }
 */
export function useTamilSearch<T extends Record<string, unknown>>(
  items: T[],
  fields: (keyof T)[]
): {
  query: string;
  setQuery: (q: string) => void;
  results: T[];
} {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items;

    return items.filter((item) =>
      fields.some((field) => {
        const value = item[field];
        if (typeof value !== "string") return false;
        return tamilMatch(value, trimmed);
      })
    );
  }, [items, fields, query]);

  return { query, setQuery, results };
}

/**
 * Convenience: single-field search (e.g. just "name").
 */
export function useTamilSearchSingle<T extends Record<string, unknown>>(
  items: T[],
  field: keyof T
) {
  return useTamilSearch(items, [field]);
}