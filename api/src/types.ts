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
  metric: Metric | 'contracts'; quote: string; source: SourceText;
  period: string | null; money: Money | null;
  offset?: number;
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
