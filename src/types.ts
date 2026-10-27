export interface StateInfo {
  id: string;
  name: string;
  sourceName: string;
  seats: number;
  majorityMark: number;
  termEnds: string;
  termEndsConfidence: 'reported' | 'approximate';
  expectedPolls: string;
  round: 1 | 2;
  governing: string;
  notes: string;
}

export type Quality = 'ok' | 'duplicate' | 'unidentified';

export interface ConstituencyProps {
  state: string;
  ac_no: number;
  ac_name: string | null;
  district: string | null;
  pc_name: string | null;
  status: string | null;
  quality: Quality;
  // Joined client-side from the 2022 results, when available.
  winner?: string;
  margin?: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  values?: number[];
}

export interface Candidate {
  name: string;
  party: string;
  votes: number;
  share: number;
}

export interface SeatResult {
  no: number;
  name: string;
  totalVotes: number;
  winner: Candidate;
  runnerUp: Candidate | null;
  margin: number;
  marginPct: number;
  nota: number;
  candidates: Candidate[];
  contestants: number;
}

export interface PartySummary {
  party: string;
  seats: number;
  votes: number;
  voteShare: number;
}

export interface StateResults {
  state: string;
  year: number;
  source: { name: string; url: string; commit: string; license: string };
  totalVotes: number;
  summary: PartySummary[];
  join: { issues: ValidationIssue[] };
  seats: Record<string, SeatResult>;
}

export interface PartyInfo {
  abbr: string;
  color: string;
}

export interface StateValidation {
  id: string;
  name: string;
  expectedSeats: number;
  features: number;
  issues: ValidationIssue[];
}

export interface ValidationReport {
  generatedAt: string;
  source: string;
  states: StateValidation[];
}
