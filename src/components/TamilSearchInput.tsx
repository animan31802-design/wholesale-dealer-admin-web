/**
 * TamilSearchInput.tsx
 *
 * Drop-in search bar component with Tamil-aware search built in.
 * Renders a standard input box — just replace your existing search
 * <input> or <TextField> with this component.
 *
 * Props:
 *   value        - controlled query string
 *   onChange     - setter from useTamilSearch
 *   placeholder  - optional placeholder text
 *   className    - optional extra CSS class for the wrapper
 */

import React from "react";

interface TamilSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export const TamilSearchInput: React.FC<TamilSearchInputProps> = ({
  value,
  onChange,
  placeholder = "Search… (English or Tamil)",
  className = "",
}) => {
  return (
    <div className={`tamil-search-wrapper ${className}`} style={wrapperStyle}>
      {/* Search icon */}
      <svg
        style={iconStyle}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx={11} cy={11} r={8} />
        <line x1={21} y1={21} x2={16.65} y2={16.65} />
      </svg>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
        spellCheck={false}
        autoComplete="off"
      />

      {/* Clear button */}
      {value && (
        <button
          onClick={() => onChange("")}
          style={clearBtnStyle}
          aria-label="Clear search"
          type="button"
        >
          ✕
        </button>
      )}
    </div>
  );
};

// ── Inline styles (safe defaults; override via className if you use Tailwind/CSS) ──
const wrapperStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  width: "100%",
};

const iconStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  width: 18,
  height: 18,
  color: "#9ca3af",
  pointerEvents: "none",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 40px 10px 40px",
  border: "1px solid #e5e7eb",
  borderRadius: 9999,
  fontSize: 14,
  outline: "none",
  backgroundColor: "#f9fafb",
  transition: "border-color 0.15s",
};

const clearBtnStyle: React.CSSProperties = {
  position: "absolute",
  right: 12,
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#9ca3af",
  fontSize: 13,
  padding: 0,
  lineHeight: 1,
};