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
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  values?: number[];
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
