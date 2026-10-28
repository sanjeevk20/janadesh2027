// Battleground projection: applies a swing scenario to each seat's 2022 notional result
// (2022 votes regrouped into the analyst's 2027 blocs) and rates how close each seat is.
//
// This is a uniform-swing model: every seat moves by the same points (or by its Lok Sabha
// seat's 2024 swing). It shows which seats are exposed to a given swing; it is not a forecast.

export interface Bloc {
  id: string;
  name: string;
  color: string;
  parties: string[];
}

export interface BgSeat {
  name: string;
  pc: number | null;
  shares: Record<string, number>;
  other: { name: string; party: string; share: number } | null;
  holder: string;
  winner2022: { name: string; party: string };
}

export interface AnalystRating {
  rating: Rating;
  bloc?: string;
  note?: string;
  analyst?: string;
  date?: string;
}

export interface AnalystScenario {
  id: string;
  name: string;
  swing: Record<string, number>;
  note?: string;
  author?: string;
}

export interface BattlegroundState {
  state: string;
  confirmed: boolean;
  note: string | null;
  blocs: Bloc[];
  seats: Record<string, BgSeat>;
  pcSwing: Record<string, Record<string, number>>;
  stateSwing: Record<string, number>;
  pcsUsed: number;
  scenarios: AnalystScenario[];
  ratings: Record<string, AnalystRating>;
}

export type Rating = 'safe' | 'likely' | 'lean' | 'tossup';
export type Base = 'baseline' | 'ls2024';

export interface Scenario {
  base: Base;
  // Extra points per bloc, added on top of the base in every seat.
  adjust: Record<string, number>;
  // Analyst scenario the sliders were loaded from, if any.
  scenarioId: string | null;
}

export interface SeatProjection {
  no: number;
  shares: Record<string, number>;
  leader: string;
  runnerUp: string | null;
  margin: number;
  modelRating: Rating;
  // The call shown and counted: the analyst's override when there is one.
  call: string;
  rating: Rating;
  analyst: AnalystRating | null;
  flip: boolean;
  swingSource: 'pc' | 'state' | 'none';
}

export interface Projection {
  seats: Map<number, SeatProjection>;
  tally: Array<{ bloc: string; seats: number }>;
  flips: number;
  tossups: number;
}

export const OTHERS = 'OTH';

// Winning margin (points) thresholds for the model's rating.
const RATING_THRESHOLDS: Array<[number, Rating]> = [
  [2, 'tossup'],
  [5, 'lean'],
  [10, 'likely'],
];

export function defaultScenario(bg: BattlegroundState): Scenario {
  return { base: 'ls2024', adjust: Object.fromEntries(bg.blocs.map((b) => [b.id, 0])), scenarioId: null };
}

export function project(bg: BattlegroundState, scenario: Scenario): Projection {
  const seats = new Map<number, SeatProjection>();
  const counts = new Map<string, number>();
  let flips = 0;
  let tossups = 0;

  for (const [key, seat] of Object.entries(bg.seats)) {
    const no = Number(key);
    let swing: Record<string, number> = {};
    let swingSource: SeatProjection['swingSource'] = 'none';
    if (scenario.base === 'ls2024') {
      const pcSwing = seat.pc !== null ? bg.pcSwing[String(seat.pc)] : undefined;
      swing = pcSwing ?? bg.stateSwing;
      swingSource = pcSwing ? 'pc' : 'state';
    }

    const shares: Record<string, number> = {};
    for (const b of bg.blocs) {
      shares[b.id] = Math.max(0, seat.shares[b.id] + (swing[b.id] ?? 0) + (scenario.adjust[b.id] ?? 0));
    }
    // The strongest non-bloc candidate keeps their 2022 share: a strong independent can win.
    if (seat.other) shares[OTHERS] = seat.other.share;

    const ranked = Object.entries(shares).sort((a, b) => b[1] - a[1]);
    const [leader, top] = ranked[0];
    const margin = ranked.length > 1 ? top - ranked[1][1] : top;
    const modelRating = rate(margin);

    const analyst = bg.ratings[key] ?? null;
    const call = analyst && analyst.rating !== 'tossup' && analyst.bloc ? analyst.bloc : leader;
    const rating = analyst?.rating ?? modelRating;
    const flip = call !== seat.holder;

    seats.set(no, {
      no,
      shares,
      leader,
      runnerUp: ranked[1]?.[0] ?? null,
      margin,
      modelRating,
      call,
      rating,
      analyst,
      flip,
      swingSource,
    });
    counts.set(call, (counts.get(call) ?? 0) + 1);
    if (flip) flips++;
    if (rating === 'tossup') tossups++;
  }

  const tally = [...counts].map(([bloc, n]) => ({ bloc, seats: n })).sort((a, b) => b.seats - a.seats);
  return { seats, tally, flips, tossups };
}

function rate(margin: number): Rating {
  return RATING_THRESHOLDS.find(([limit]) => margin < limit)?.[1] ?? 'safe';
}
