export interface Position {
  x: number;
  y: number;
}

/** Saved module positions live in this browser only; storage may be unavailable, so every access is guarded. */
export function loadPositions(key: string): Map<string, Position> {
  try {
    const stored = localStorage.getItem(key);
    return new Map(stored === null ? [] : (JSON.parse(stored) as [string, Position][]));
  } catch {
    return new Map();
  }
}

export function savePositions(key: string, positions: Map<string, Position>) {
  try {
    if (positions.size === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify([...positions]));
    }
  } catch {
    // Positions are a convenience; losing them is fine.
  }
}
