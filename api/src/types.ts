export type Metric = 'revenue' | 'cash' | 'debt';
export type Decision = 'YES' | 'NO' | 'NEEDS_REVIEW';
export interface Segment {
  source: string; start: number; end: number; speaker: string | null; text: string;
}
export interface SourceText {
  name: string; text: string; mocked: boolean; segments?: Segment[];
}
export interface Money { cents: bigint; quantum: bigint }
export interface Claim {
  metric: Metric | 'contracts' | 'text' | 'contract' | 'other-money'; quote: string; source: SourceText;
  period: string | null; money: Money | null;
  type?: 'money' | 'text' | 'contract';
  stated?: { amount: string; unit: string; period: string };
  offset?: number;
  // Index of the claimed amount inside `quote`; lets code read the metric name that precedes it.
  amountIndex?: number;
  // The amount is followed by a scale word code cannot parse. No amount is shown; the claim needs review.
  scaleUnparsed?: boolean;
  // The table scale in effect where a proof amount was read (1 = plain dollars); lets later checks judge the unit.
  scale?: bigint;
}
export interface Finding {
  id: string; claim: string;
  claim_source: { name: string; quote: string; timestamp_start: number | null; timestamp_end: number | null; speaker: string | null };
  label: 'supported' | 'discrepancy' | 'insufficient'; decision: Decision;
  jev_probability: number | null; explanation: string;
  proof_source: { name: string; quote: string; url: string | null } | null;
  claimed_usd: string | null; proof_usd: string | null; gap_usd: string | null; gap_pct: string | null;
  priority: 'high' | 'medium' | 'low'; next_action: string; mocked: boolean;
}
export interface CheckResponse {
  company: string; period: string; findings: Finding[];
  sources: { name: string; type: 'upload' | 'sec'; date: string | null; url: string | null }[];
  transcript: { segments: Segment[] } | null;
}
