interface PaginationProps {
  total: number;
  page: number;
  perPage: number;
  onPage: (page: number) => void;
}

export default function Pagination({ total, page, perPage, onPage }: PaginationProps) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return null;

  const from = (page - 1) * perPage + 1;
  const to   = Math.min(page * perPage, total);

  // Build page numbers — show max 5 around current
  const pages: (number | "...")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push("...");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-white">
      <p className="text-xs text-gray-400">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          className="px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ‹
        </button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`dots-${i}`} className="px-2 text-gray-400 text-sm">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p as number)}
              className={`w-8 h-8 text-sm rounded-lg font-medium transition-all ${
                p === page
                  ? "bg-orange-500 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page === totalPages}
          className="px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ›
        </button>
      </div>
    </div>
  );
}