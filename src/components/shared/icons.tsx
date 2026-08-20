/**
 * Icons drawn in more than one place.
 *
 * The edit pencil was inlined at four sites and had already drifted: two drew
 * it at strokeWidth 2 and two at 2.2, and the two halves of the path were
 * spelled with and without spaces in the arc flags. Nobody chose that.
 */

/** Pencil-over-page: opens the thing it sits on for editing. */
export function EditIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
