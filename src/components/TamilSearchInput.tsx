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

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function TamilSearchInput({
  value,
  onChange,
  placeholder = "Search… (English or Tamil)",
  className = "",
}: Props) {
  return (
    <div className={`relative flex items-center ${className}`}>
      <svg
        className="absolute left-3 w-4 h-4 text-gray-400 pointer-events-none shrink-0"
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
        spellCheck={false}
        autoComplete="off"
        className="border border-gray-300 rounded-lg pl-9 pr-8 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-orange-400"
      />

      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 text-gray-400 hover:text-gray-600 text-xs px-1"
        >
          ✕
        </button>
      )}
    </div>
  );
}