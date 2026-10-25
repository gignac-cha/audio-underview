/**
 * The play/pause triangle-and-bars, shared by the hero card and the floating
 * transport so the two never drift apart. Inline SVG so the app still pulls in
 * no icon dependency.
 */

export interface TransportGlyphProps {
  playing: boolean;
  /** Rendered edge length in pixels; the viewBox is fixed. */
  size?: number;
}

export function TransportGlyph({ playing, size = 18 }: TransportGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      {playing ? (
        <path fill="currentColor" d="M4 2h4v14H4zM10 2h4v14h-4z" />
      ) : (
        <path fill="currentColor" d="M4 2l12 7-12 7z" />
      )}
    </svg>
  );
}
