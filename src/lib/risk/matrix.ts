import { correlation, covariance } from "./stats";

export function covarianceMatrix(rows: number[][]): number[][] {
  const n = rows.length;
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const c = covariance(rows[i], rows[j]);
      m[i][j] = c;
      m[j][i] = c;
    }
  }
  return m;
}

export function correlationMatrix(rows: number[][]): number[][] {
  const n = rows.length;
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = correlation(rows[i], rows[j]);
      m[i][j] = c;
      m[j][i] = c;
    }
  }
  return m;
}

/**
 * Eigenvalues of a real symmetric matrix via the cyclic Jacobi rotation
 * method. Used for the "effective number of independent bets" metric, which
 * needs the eigenvalue spectrum of the correlation matrix.
 *
 * Jacobi is O(n^3) per sweep and overkill for large n, but portfolios here are
 * a handful of assets and it is numerically bulletproof for symmetric input —
 * which matters more than speed at this size.
 */
export function symmetricEigenvalues(input: number[][]): number[] {
  const n = input.length;
  if (n === 0) return [];
  if (n === 1) return [input[0][0]];

  const a = input.map((row) => [...row]);

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    }
    if (off < 1e-14) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }

  return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => y - x);
}

/**
 * Cholesky decomposition with a diagonal ridge fallback.
 *
 * Sample correlation matrices from short windows are frequently not positive
 * definite (especially with more assets than observations). Rather than
 * failing, we progressively shrink toward the identity until the
 * decomposition succeeds — standard practice in risk systems, and the shrink
 * factor is reported so the UI can be honest about it.
 */
export function choleskyWithShrinkage(matrix: number[][]): {
  lower: number[][];
  shrinkage: number;
} {
  const n = matrix.length;
  for (const shrinkage of [0, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1]) {
    const m = matrix.map((row, i) =>
      row.map((v, j) =>
        i === j ? v * (1 - shrinkage) + shrinkage : v * (1 - shrinkage),
      ),
    );
    const l: number[][] = Array.from({ length: n }, () =>
      new Array(n).fill(0),
    );
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = m[i][j];
        for (let k = 0; k < j; k++) sum -= l[i][k] * l[j][k];
        if (i === j) {
          if (sum <= 1e-12) {
            ok = false;
            break;
          }
          l[i][j] = Math.sqrt(sum);
        } else {
          l[i][j] = sum / l[j][j];
        }
      }
    }
    if (ok) return { lower: l, shrinkage };
  }
  // Fully degenerate: fall back to independence.
  const identity = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  return { lower: identity, shrinkage: 1 };
}
