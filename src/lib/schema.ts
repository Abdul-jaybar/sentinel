import { z } from "zod";

export const positionSchema = z.object({
  id: z.string().min(1).max(64),
  coinId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "coinId must be a CoinGecko slug"),
  symbol: z.string().min(1).max(16),
  quantity: z.number().finite().refine((v) => v !== 0, "quantity cannot be zero"),
  entryPrice: z.number().finite().positive(),
  leverage: z.number().finite().min(1).max(125),
  venue: z.enum(["spot", "perp", "defi"]),
  maintenanceMarginRate: z.number().finite().min(0).max(0.5).optional(),
});

export const riskRequestSchema = z.object({
  positions: z.array(positionSchema).min(1).max(25),
  horizonDays: z.number().int().min(1).max(180).default(30),
  ruinThreshold: z.number().min(0.05).max(0.95).default(0.5),
  lookbackDays: z.number().int().min(30).max(365).default(90),
  paths: z.number().int().min(200).max(5000).default(2000),
  benchmarkCoinId: z.string().min(1).max(64).default("bitcoin"),
  skipPrescription: z.boolean().default(false),
});

export type RiskRequest = z.infer<typeof riskRequestSchema>;

/**
 * Validation request.
 *
 * `lookbackDays` is allowed to run far past the dashboard's 365-day ceiling
 * here, because the whole point of a walk-forward test is to spend most of the
 * sample on training and still have years left to score against. The committed
 * dataset is what makes that possible offline.
 */
export const backtestRequestSchema = z.object({
  positions: z.array(positionSchema).min(1).max(25),
  lookbackDays: z.number().int().min(180).max(2400).default(730),
  trainWindow: z.number().int().min(60).max(750).default(120),
  horizonDays: z.number().int().min(5).max(180).default(30),
  ruinThreshold: z.number().min(0.05).max(0.95).default(0.5),
  benchmarkCoinId: z.string().min(1).max(64).default("bitcoin"),
});

export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

export const explainRequestSchema = z.object({
  question: z.string().min(1).max(500).optional(),
  context: z.unknown(),
});
