import maplibregl, { type LngLatBoundsLike, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import statesData from '../data/states.json';
import partiesData from '../data/parties.json';
import type {
  ConstituencyProps,
  LsStateResults,
  NewsItem,
  PartyInfo,
  PcResult,
  SeatResult,
  StateInfo,
  StateResults,
  ValidationIssue,
  ValidationReport,
} from './types';
import {
  defaultScenario,
  OTHERS,
  project,
  type BattlegroundState,
  type Projection,
  type Rating,
  type Scenario,
} from './battleground';

const STATES = statesData.states as StateInfo[];
const PARTY_COLORS: Record<string, string> = Object.fromEntries(
  Object.values(partiesData.parties as Record<string, PartyInfo>).map((p) => [p.abbr, p.color]),
);
const OTHER_PARTY_COLOR = partiesData._meta.otherColor;
const NO_DATA_COLOR = '#d9d9d9';

// One hue per state; chosen to stay distinguishable on a light basemap.
const STATE_COLORS: Record<string, string> = {
  UP: '#e07b39',
  PB: '#3a8fb7',
  UK: '#5aa469',
  GA: '#c25b8f',
  MN: '#8a6fc4',
  GJ: '#d4a72c',
  HP: '#3fa7a0',
};
// Winning margin as % of votes polled; darkest = closest contests.
const MARGIN_BUCKETS: Array<[number, string, string]> = [
  [0, '#7a0177', '< 2%'],
  [2, '#c51b8a', '2–5%'],
  [5, '#f768a1', '5–10%'],
  [10, '#fbb4b9', '10–20%'],
  [20, '#feebe2', '≥ 20%'],
];
// Change in NDA vote share (percentage points), 2022 assembly → 2024 Lok Sabha.
// Diverging: purple = NDA lost ground, orange = NDA gained.
const SWING_BUCKETS: Array<[number, string, string]> = [
  [-Infinity, '#542788', '≤ −10'],
  [-10, '#998ec3', '−10 to −5'],
  [-5, '#d8daeb', '−5 to −2'],
  [-2, '#f7f7f7', '±2'],
  [2, '#fee0b6', '+2 to +5'],
  [5, '#f1a340', '+5 to +10'],
  [10, '#b35806', '≥ +10'],
];
const ISSUE_COLOR = '#d7263d';
// Battleground: projected bloc colour, faded for weaker ratings; toss-ups get their own colour.
const TOSSUP_COLOR = '#ffd166';
const RATING_OPACITY: Record<Rating, number> = { safe: 0.9, likely: 0.7, lean: 0.45, tossup: 0.9 };
const RATING_LABELS: Record<Rating, string> = { safe: 'Safe', likely: 'Likely', lean: 'Lean', tossup: 'Toss-up' };
const SWING_SLIDER_LIMIT = 15;
// GitHub issue form for community news tips (moderated before publishing).
const NEWS_TIP_URL = 'https://github.com/sanjeevk20/janadesh2027/issues/new?template=news-tip.yml';
const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/positron';
// Used when the basemap is unreachable, so the constituency layers still render.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0f2' } }],
};
const INDIA_BOUNDS: LngLatBoundsLike = [
  [68, 8],
  [92, 33],
];

type ColorMode = 'winner' | 'margin' | 'ls2024' | 'swing' | 'battleground' | 'state';

const panel = {
  list: document.getElementById('state-list')!,
  detail: document.getElementById('detail')!,
  legend: document.getElementById('legend')!,
  toggle: document.getElementById('toggle-issues') as HTMLInputElement,
  modes: document.getElementById('color-mode')!,
};

type Feature = GeoJSON.Feature<GeoJSON.Geometry, ConstituencyProps>;

let validation: ValidationReport | null = null;
const results = new Map<string, StateResults>();
const ls2024 = new Map<string, LsStateResults>();
const battleground = new Map<string, BattlegroundState>();
const scenarios = new Map<string, Scenario>();
const projections = new Map<string, Projection>();
let news: NewsItem[] = [];
let newsUpdated: string | null = null;
let features: Feature[] = [];
let selectedState: string | null = null;
let colorMode: ColorMode = 'winner';

const map = new maplibregl.Map({
  container: 'map',
  style: await loadBasemapStyle(),
  bounds: INDIA_BOUNDS,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

renderStateList();
renderLegend();
renderOverview();

map.on('load', async () => {
  const [collections, report, stateResults, lsResults, bgData, newsData] = await Promise.all([
    Promise.all(STATES.map((s) => fetchJson<GeoJSON.FeatureCollection>(`data/boundaries/${s.id}.geojson`))),
    fetchJson<ValidationReport>('data/validation.json'),
    // Results are optional per state (Gujarat and Himachal are not sourced yet).
    Promise.all(STATES.map((s) => fetchJson<StateResults>(`data/results/2022-${s.id}.json`).catch(() => null))),
    Promise.all(STATES.map((s) => fetchJson<LsStateResults>(`data/ls2024/${s.id}.json`).catch(() => null))),
    Promise.all(STATES.map((s) => fetchJson<BattlegroundState>(`data/battleground/${s.id}.json`).catch(() => null))),
    fetchJson<{ generatedAt?: string; items: NewsItem[] }>('data/news.json').catch(() => ({ items: [] })),
  ]);
  news = newsData.items;
  newsUpdated = 'generatedAt' in newsData ? newsData.generatedAt ?? null : null;
  validation = report;
  for (const r of stateResults) if (r) results.set(r.state, r);
  for (const r of lsResults) if (r) ls2024.set(r.state, r);
  for (const bg of bgData) {
    if (!bg) continue;
    battleground.set(bg.state, bg);
    scenarios.set(bg.state, defaultScenario(bg));
    projections.set(bg.state, project(bg, scenarios.get(bg.state)!));
  }

  features = collections.flatMap((c) => c.features as Feature[]);
  features.forEach((f, i) => {
    f.id = i;
    const seat = seatResult(f.properties);
    if (seat) {
      f.properties.winner = seat.winner.party;
      f.properties.margin = seat.marginPct;
    }
    const pc = pcResult(f.properties);
    if (pc?.winner) f.properties.ls24 = pc.winner.party;
    if (pc?.swing) f.properties.swing = pc.swing.ndaChange;
  });

  map.addSource('acs', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
    attribution:
      'Boundaries © <a href="https://github.com/datameet/maps">DataMeet</a> (CC BY 2.5 IN) · ' +
      'Results: <a href="https://github.com/thecont1/india-votes-data">india-votes-data</a>, ' +
      '<a href="https://github.com/answerquest/india-elections2024-results-timewise">india-elections2024</a> / ECI',
  });

  map.addLayer({
    id: 'ac-fill',
    type: 'fill',
    source: 'acs',
    paint: {
      'fill-color': fillColorExpression(),
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0.75],
    },
  });
  map.addLayer({
    id: 'ac-line',
    type: 'line',
    source: 'acs',
    paint: { 'line-color': '#ffffff', 'line-width': 0.6 },
  });
  // Seats that change hands under the battleground scenario; shown only in that mode.
  map.addLayer({
    id: 'ac-flip-line',
    type: 'line',
    source: 'acs',
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#1d1d1f',
      'line-width': 1.6,
      'line-opacity': ['case', ['boolean', ['feature-state', 'bgFlip'], false], 1, 0],
    },
  });
  map.addLayer({
    id: 'ac-issue-line',
    type: 'line',
    source: 'acs',
    filter: ['!=', ['get', 'quality'], 'ok'],
    paint: { 'line-color': ISSUE_COLOR, 'line-width': 1.5 },
  });

  for (const id of battleground.keys()) paintBattleground(id);
  wireInteractions();
  renderStateList();
  renderLegend();
  if (selectedState) renderStateDetail(selectedState);
  else renderOverview();
});

// Results are only attached to shapes we can trust to be the right seat: shapes with no
// valid number get nothing, and duplicated numbers still get the result but are flagged.
function seatResult(p: ConstituencyProps): SeatResult | undefined {
  if (p.quality === 'unidentified') return undefined;
  return results.get(p.state)?.seats[String(p.ac_no)];
}

function pcResult(p: ConstituencyProps): PcResult | undefined {
  if (p.quality === 'unidentified') return undefined;
  const ls = ls2024.get(p.state);
  const pcNo = ls?.acToPc[String(p.ac_no)];
  return pcNo === undefined ? undefined : ls!.pcs[String(pcNo)];
}

function fillColorExpression(): maplibregl.ExpressionSpecification {
  const highlight = panel.toggle.checked;
  let base: maplibregl.ExpressionSpecification;
  if (colorMode === 'state') {
    base = ['match', ['get', 'state'], ...Object.entries(STATE_COLORS).flat(), NO_DATA_COLOR] as never;
    return highlight ? ['case', ['!=', ['get', 'quality'], 'ok'], ISSUE_COLOR, base] : base;
  }
  if (colorMode === 'winner' || colorMode === 'ls2024') {
    const prop = colorMode === 'winner' ? 'winner' : 'ls24';
    base = ['match', ['get', prop], ...Object.entries(PARTY_COLORS).flat(), OTHER_PARTY_COLOR] as never;
    return ['case', ['has', prop], base, NO_DATA_COLOR];
  }
  if (colorMode === 'battleground') {
    return ['coalesce', ['feature-state', 'bgColor'], NO_DATA_COLOR];
  }
  if (colorMode === 'swing') {
    base = ['step', ['get', 'swing'], SWING_BUCKETS[0][1], ...SWING_BUCKETS.slice(1).flatMap(([t, c]) => [t, c])] as never;
    return ['case', ['has', 'swing'], base, NO_DATA_COLOR];
  }
  base = ['step', ['get', 'margin'], MARGIN_BUCKETS[0][1], ...MARGIN_BUCKETS.slice(1).flatMap(([t, c]) => [t, c])] as never;
  return ['case', ['has', 'margin'], base, NO_DATA_COLOR];
}

function wireInteractions() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  let hoveredId: number | string | undefined;

  map.on('mousemove', 'ac-fill', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    if (hoveredId !== undefined) map.setFeatureState({ source: 'acs', id: hoveredId }, { hover: false });
    hoveredId = f.id;
    map.setFeatureState({ source: 'acs', id: hoveredId! }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
    popup.setLngLat(e.lngLat).setHTML(tooltipHtml(f)).addTo(map);
  });

  map.on('mouseleave', 'ac-fill', () => {
    if (hoveredId !== undefined) map.setFeatureState({ source: 'acs', id: hoveredId }, { hover: false });
    hoveredId = undefined;
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  map.on('click', 'ac-fill', (e) => {
    const f = e.features?.[0];
    if (f) renderConstituency(f.properties as ConstituencyProps);
  });

  panel.toggle.addEventListener('change', () => {
    map.setPaintProperty('ac-fill', 'fill-color', fillColorExpression());
    map.setLayoutProperty('ac-issue-line', 'visibility', panel.toggle.checked ? 'visible' : 'none');
  });

  panel.modes.querySelectorAll<HTMLButtonElement>('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      colorMode = btn.dataset.mode as ColorMode;
      panel.modes
        .querySelectorAll('button')
        .forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      applyModePaint();
      renderLegend();
      if (selectedState) renderStateDetail(selectedState);
    }),
  );
}

function applyModePaint() {
  const bgMode = colorMode === 'battleground';
  map.setPaintProperty('ac-fill', 'fill-color', fillColorExpression());
  map.setPaintProperty('ac-fill', 'fill-opacity', [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    0.95,
    bgMode ? ['coalesce', ['feature-state', 'bgOpacity'], 0.75] : 0.75,
  ]);
  map.setLayoutProperty('ac-flip-line', 'visibility', bgMode ? 'visible' : 'none');
}

function tooltipHtml(f: MapGeoJSONFeature): string {
  const p = f.properties as ConstituencyProps;
  const name = p.ac_name || 'Unnamed shape';
  const no = p.ac_no ? `#${p.ac_no}` : 'no number';
  const seat = seatResult(p);
  const pc = pcResult(p);
  const result =
    (seat ? `<div>2022: <strong>${escapeHtml(seat.winner.party)}</strong> by ${seat.marginPct}%</div>` : '') +
    (pc?.winner ? `<div>2024 LS (${escapeHtml(pc.name)}): <strong>${escapeHtml(pc.winner.party)}</strong></div>` : '') +
    (pc?.swing ? `<div>NDA swing: ${signed(pc.swing.ndaChange)} pts</div>` : '') +
    (colorMode === 'battleground' ? battlegroundTip(p) : '');
  const flag = p.quality !== 'ok' ? `<div class="tip-flag">⚠ ${qualityLabel(p.quality)}</div>` : '';
  return `<strong>${escapeHtml(name)}</strong> <span class="muted">${no}</span><br>${escapeHtml(p.district ?? '')}${result}${flag}`;
}

function selectState(id: string) {
  selectedState = id;
  const bounds = boundsOf(features.filter((f) => f.properties.state === id));
  if (bounds) map.fitBounds(bounds, { padding: 32, duration: 800 });
  renderStateList();
  renderStateDetail(id);
  renderLegend();
}

function selectSeat(state: string, no: number) {
  const matches = features.filter((f) => f.properties.state === state && f.properties.ac_no === no);
  const bounds = boundsOf(matches);
  if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 9, duration: 800 });
  if (matches[0]) renderConstituency(matches[0].properties);
}

function renderStateList() {
  const rounds: Array<[1 | 2, string]> = [
    [1, 'Round 1 · expected Feb–Mar 2027'],
    [2, 'Round 2 · expected Nov–Dec 2027'],
  ];
  panel.list.innerHTML = rounds
    .map(([round, label]) => {
      const cards = STATES.filter((s) => s.round === round)
        .map((s) => {
          const issues = stateIssues(s.id).length;
          const badge = issues ? `<span class="badge">${issues} data issue${issues > 1 ? 's' : ''}</span>` : '';
          const leader = results.get(s.id)?.summary[0];
          const ls = ls2024.get(s.id)?.summary
            .slice(0, 2)
            .map((p) => `${escapeHtml(p.party)} ${p.seats}`)
            .join(', ');
          const sub =
            (leader
              ? `<span class="state-sub">2022: ${escapeHtml(leader.party)} ${leader.seats}</span>`
              : validation
              ? `<span class="state-sub muted">2022 results pending</span>`
              : '') + (ls ? `<span class="state-sub muted">2024 LS: ${ls}</span>` : '');
          return `
            <button class="state-card${selectedState === s.id ? ' active' : ''}" data-id="${s.id}">
              <span class="swatch" style="background:${STATE_COLORS[s.id]}"></span>
              <span class="state-name">${s.name}</span>
              <span class="state-seats">${s.seats} seats</span>
              ${sub}${badge}
            </button>`;
        })
        .join('');
      return `<h2 class="round">${label}</h2><div class="cards">${cards}</div>`;
    })
    .join('');

  panel.list.querySelectorAll<HTMLButtonElement>('.state-card').forEach((btn) =>
    btn.addEventListener('click', () => selectState(btn.dataset.id!)),
  );
}

function stateIssues(id: string): ValidationIssue[] {
  return [
    ...(validation?.states.find((v) => v.id === id)?.issues ?? []),
    ...(results.get(id)?.join.issues ?? []),
    ...(ls2024.get(id)?.join.issues ?? []),
  ];
}

function renderOverview() {
  const total = STATES.reduce((n, s) => n + s.seats, 0);
  const flagged = validation?.states.filter((s) => s.issues.length).map((s) => s.name) ?? [];
  const covered = STATES.filter((s) => results.has(s.id));
  const pending = STATES.filter((s) => !results.has(s.id));
  const coveredSeats = covered.reduce((n, s) => n + s.seats, 0);

  panel.detail.innerHTML = `
    <h2>Overview</h2>
    <p>${STATES.length} states and <strong>${total}</strong> assembly seats go to the polls in 2027.
    Pick a state, or click any constituency on the map.</p>
    ${
      covered.length
        ? `<p>2022 results are loaded for <strong>${coveredSeats}</strong> seats in ${covered
            .map((s) => s.name)
            .join(', ')}.${
            pending.length ? ` ${pending.map((s) => s.name).join(' and ')} are pending a data source.` : ''
          }</p>`
        : ''
    }
    ${
      flagged.length
        ? `<p class="callout">The boundary source has issues in <strong>${flagged.join(', ')}</strong>.
           Outlined in <span style="color:${ISSUE_COLOR}">red</span>: shapes that could not be matched to a valid seat.</p>`
        : ''
    }
    <p class="muted small">Poll windows are expectations based on assembly term expiry. The Election
    Commission has not announced schedules yet.</p>
    ${newsHtml(news.slice(0, 5), 'Latest news', 'No news collected yet.')}
    ${
      newsUpdated
        ? `<p class="muted small">News refreshed daily at 06:17 IST · last refresh ${new Date(newsUpdated).toLocaleString('en-IN', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Kolkata',
          })} IST</p>`
        : ''
    }`;
}

function renderStateDetail(id: string) {
  const s = STATES.find((x) => x.id === id)!;
  const r = results.get(id);
  const termNote = s.termEndsConfidence === 'approximate' ? ' <span class="muted">(approx.)</span>' : '';

  panel.detail.innerHTML = `
    <button class="link" id="back">← All states</button>
    <h2>${s.name}</h2>
    <dl class="facts">
      <dt>Seats</dt><dd>${s.seats} (majority ${s.majorityMark})</dd>
      <dt>Governing</dt><dd>${escapeHtml(s.governing)}</dd>
      <dt>Term ends</dt><dd>${s.termEnds}${termNote}</dd>
      <dt>Expected polls</dt><dd>${s.expectedPolls}</dd>
    </dl>
    ${s.notes ? `<p>${escapeHtml(s.notes)}</p>` : ''}
    ${battleground.has(id) ? battlegroundHtml(id) : ''}
    ${r ? stateResultsHtml(s, r) : `<h3>2022 results</h3><p class="muted">Not available yet: no 2022 results source has been added for ${s.name}.</p>`}
    ${ls2024.has(id) ? stateLsHtml(ls2024.get(id)!) : ''}
    ${newsHtml(news.filter((n) => n.states.includes(id)).slice(0, 6), 'News', `No news tagged to ${s.name} yet.`)}
    ${issuesHtml(s)}`;

  document.getElementById('back')!.addEventListener('click', resetView);
  panel.detail.querySelectorAll<HTMLButtonElement>('[data-seat]').forEach((btn) =>
    btn.addEventListener('click', () => selectSeat(id, Number(btn.dataset.seat))),
  );
  panel.detail.querySelectorAll<HTMLButtonElement>('[data-pc]').forEach((btn) =>
    btn.addEventListener('click', () => selectPc(id, Number(btn.dataset.pc))),
  );
  if (battleground.has(id)) wireBattlegroundControls(id);
}

// --- Battleground ---------------------------------------------------------------------------

function blocInfo(stateId: string, blocId: string): { name: string; color: string } {
  if (blocId === OTHERS) return { name: 'Others', color: OTHER_PARTY_COLOR };
  const b = battleground.get(stateId)?.blocs.find((x) => x.id === blocId);
  return b ? { name: b.name, color: b.color } : { name: blocId, color: OTHER_PARTY_COLOR };
}

// Pushes the current projection for one state onto the map through feature state, so slider
// changes repaint without reloading the GeoJSON source.
function paintBattleground(stateId: string) {
  const proj = projections.get(stateId);
  if (!proj) return;
  for (const f of features) {
    if (f.properties.state !== stateId || f.properties.quality === 'unidentified') continue;
    const sp = proj.seats.get(f.properties.ac_no);
    if (!sp) continue;
    map.setFeatureState(
      { source: 'acs', id: f.id! },
      {
        bgColor: sp.rating === 'tossup' ? TOSSUP_COLOR : blocInfo(stateId, sp.call).color,
        bgOpacity: RATING_OPACITY[sp.rating],
        bgFlip: sp.flip,
      },
    );
  }
}

function updateBattleground(stateId: string) {
  projections.set(stateId, project(battleground.get(stateId)!, scenarios.get(stateId)!));
  paintBattleground(stateId);
  const target = document.getElementById('bg-result');
  if (target) target.innerHTML = battlegroundResultHtml(stateId);
  wireSeatLinks(stateId, target);
}

function battlegroundHtml(stateId: string): string {
  const bg = battleground.get(stateId)!;
  const sc = scenarios.get(stateId)!;
  const sliders = bg.blocs
    .map(
      (b) => `<label class="bg-slider">
        <span><i class="dot" style="background:${b.color}"></i>${escapeHtml(b.name)}</span>
        <input type="range" min="${-SWING_SLIDER_LIMIT}" max="${SWING_SLIDER_LIMIT}" step="0.5"
          value="${sc.adjust[b.id] ?? 0}" data-bloc="${escapeHtml(b.id)}" aria-label="${escapeHtml(b.name)} swing adjustment" />
        <output>${signed(sc.adjust[b.id] ?? 0)}</output>
      </label>`,
    )
    .join('');
  const options = bg.scenarios
    .map((x) => `<option value="${escapeHtml(x.id)}"${sc.scenarioId === x.id ? ' selected' : ''}>${escapeHtml(x.name)}</option>`)
    .join('');
  return `
    <h3>Battleground 2027</h3>
    ${
      bg.confirmed
        ? ''
        : `<p class="callout small">Alliances (blocs) are <strong>provisional defaults</strong> pending analyst review.
           ${bg.note ? escapeHtml(bg.note) : ''}</p>`
    }
    ${colorMode === 'battleground' ? '' : `<p class="small"><button class="link" id="bg-show">Show on map</button></p>`}
    <div class="bg-controls">
      <div class="segmented small-seg" role="radiogroup" aria-label="Swing base">
        <button role="radio" data-base="baseline" aria-checked="${sc.base === 'baseline'}">2022 notional</button>
        <button role="radio" data-base="ls2024" aria-checked="${sc.base === 'ls2024'}">+ 2024 swing</button>
      </div>
      <label class="small">Analyst scenario
        <select id="bg-scenario"><option value="">Custom</option>${options}</select>
      </label>
      <div class="small muted">Extra swing on top, in points:</div>
      ${sliders}
      <button class="link small" id="bg-reset">Reset</button>
    </div>
    <div id="bg-result">${battlegroundResultHtml(stateId)}</div>`;
}

function battlegroundResultHtml(stateId: string): string {
  const s = STATES.find((x) => x.id === stateId)!;
  const bg = battleground.get(stateId)!;
  const proj = projections.get(stateId)!;
  const sc = scenarios.get(stateId)!;
  const total = Object.keys(bg.seats).length;
  const bar = proj.tally
    .map((t) => {
      const info = blocInfo(stateId, t.bloc);
      return `<span style="flex:${t.seats};background:${info.color}" title="${escapeHtml(info.name)}: ${t.seats}"></span>`;
    })
    .join('');
  const chips = proj.tally
    .map((t) => {
      const info = blocInfo(stateId, t.bloc);
      const won = t.seats >= s.majorityMark ? ' class="chip majority"' : ' class="chip"';
      return `<span${won}><i class="dot" style="background:${info.color}"></i>${escapeHtml(info.name)} ${t.seats}</span>`;
    })
    .join('');
  const seatRow = (no: number) => {
    const sp = proj.seats.get(no)!;
    const seat = bg.seats[String(no)];
    const call = blocInfo(stateId, sp.call).name;
    const from = blocInfo(stateId, seat.holder).name;
    return `<li><button class="link" data-seat="${no}">${escapeHtml(seat.name)}</button>
      <span class="muted small">${sp.flip ? `${escapeHtml(from)} → ` : ''}${escapeHtml(call)} · ${RATING_LABELS[sp.rating]}
      (${sp.margin.toFixed(1)} pts)${sp.analyst ? ' · analyst' : ''}</span></li>`;
  };
  const flips = [...proj.seats.values()].filter((sp) => sp.flip).sort((a, b) => a.margin - b.margin);
  const marginal = [...proj.seats.values()].sort((a, b) => a.margin - b.margin).slice(0, 8);
  const baseText =
    sc.base === 'ls2024'
      ? `2022 result + each Lok Sabha seat's 2024 swing (${bg.pcsUsed} seats measured; the rest use the state average)`
      : '2022 result regrouped into these blocs';
  const adjust = Object.entries(sc.adjust).filter(([, v]) => v !== 0);
  return `
    <div class="seat-bar" aria-hidden="true">${bar}<span class="majority-line" style="left:${(s.majorityMark / total) * 100}%"></span></div>
    <div class="majority-note muted small">Majority ${s.majorityMark} of ${total}</div>
    <div class="chips">${chips}</div>
    <p class="small"><strong>${proj.flips}</strong> seats change hands · <strong>${proj.tossups}</strong> toss-ups</p>
    <p class="muted small">Scenario: ${baseText}${
      adjust.length ? `, then ${adjust.map(([b, v]) => `${escapeHtml(blocInfo(stateId, b).name)} ${signed(v)}`).join(', ')}` : ''
    }. Uniform-swing projection, not a forecast.</p>
    ${flips.length ? `<h4>Seats that change hands (${flips.length})</h4><ol class="closest">${flips.slice(0, 10).map((x) => seatRow(x.no)).join('')}</ol>` : ''}
    <h4>Closest seats</h4><ol class="closest">${marginal.map((x) => seatRow(x.no)).join('')}</ol>`;
}

function wireSeatLinks(stateId: string, root: HTMLElement | null) {
  root?.querySelectorAll<HTMLButtonElement>('[data-seat]').forEach((btn) =>
    btn.addEventListener('click', () => selectSeat(stateId, Number(btn.dataset.seat))),
  );
}

function wireBattlegroundControls(stateId: string) {
  const bg = battleground.get(stateId)!;
  const sc = scenarios.get(stateId)!;
  const select = document.getElementById('bg-scenario') as HTMLSelectElement | null;
  const sliders = [...panel.detail.querySelectorAll<HTMLInputElement>('.bg-slider input')];
  const syncSliders = () =>
    sliders.forEach((el) => {
      el.value = String(sc.adjust[el.dataset.bloc!] ?? 0);
      el.nextElementSibling!.textContent = signed(Number(el.value));
    });

  document.getElementById('bg-show')?.addEventListener('click', () => {
    panel.modes.querySelector<HTMLButtonElement>('[data-mode="battleground"]')?.click();
  });
  panel.detail.querySelectorAll<HTMLButtonElement>('[data-base]').forEach((btn) =>
    btn.addEventListener('click', () => {
      sc.base = btn.dataset.base as Scenario['base'];
      panel.detail.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      updateBattleground(stateId);
    }),
  );
  let frame = 0;
  sliders.forEach((el) =>
    el.addEventListener('input', () => {
      sc.adjust[el.dataset.bloc!] = Number(el.value);
      sc.scenarioId = null;
      if (select) select.value = '';
      el.nextElementSibling!.textContent = signed(Number(el.value));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => updateBattleground(stateId));
    }),
  );
  select?.addEventListener('change', () => {
    const chosen = bg.scenarios.find((x) => x.id === select.value);
    for (const b of bg.blocs) sc.adjust[b.id] = chosen?.swing[b.id] ?? 0;
    sc.scenarioId = chosen?.id ?? null;
    syncSliders();
    updateBattleground(stateId);
  });
  document.getElementById('bg-reset')?.addEventListener('click', () => {
    Object.assign(sc, defaultScenario(bg));
    if (select) select.value = '';
    panel.detail.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-checked', String((b as HTMLElement).dataset.base === sc.base)));
    syncSliders();
    updateBattleground(stateId);
  });
}

function battlegroundTip(p: ConstituencyProps): string {
  const sp = p.quality === 'unidentified' ? undefined : projections.get(p.state)?.seats.get(p.ac_no);
  if (!sp) return '';
  const call = blocInfo(p.state, sp.call).name;
  return `<div>2027 projection: <strong>${escapeHtml(call)}</strong> · ${RATING_LABELS[sp.rating]}${sp.flip ? ' · <strong>flips</strong>' : ''}</div>`;
}

function seatBattlegroundHtml(p: ConstituencyProps): string {
  const bg = battleground.get(p.state);
  const sp = p.quality === 'unidentified' ? undefined : projections.get(p.state)?.seats.get(p.ac_no);
  if (!bg || !sp) return '';
  const seat = bg.seats[String(p.ac_no)];
  const rows = Object.entries(sp.shares)
    .sort((a, b) => b[1] - a[1])
    .map(([b, now]) => {
      const info = blocInfo(p.state, b);
      const then = b === OTHERS ? seat.other?.share ?? 0 : seat.shares[b];
      const label = b === OTHERS && seat.other ? `Others (best: ${seat.other.name}, ${seat.other.party})` : info.name;
      return `<tr><td><i class="dot" style="background:${info.color}"></i>${escapeHtml(label)}</td>
        <td class="num">${then.toFixed(1)}%</td><td class="num">${now.toFixed(1)}%</td></tr>`;
    })
    .join('');
  const holder = blocInfo(p.state, seat.holder).name;
  const call = blocInfo(p.state, sp.call).name;
  const analyst = sp.analyst
    ? `<p class="callout small"><strong>Analyst rating: ${RATING_LABELS[sp.analyst.rating]}${
        sp.analyst.bloc ? ` ${escapeHtml(blocInfo(p.state, sp.analyst.bloc).name)}` : ''
      }</strong>${sp.analyst.note ? ` — ${escapeHtml(sp.analyst.note)}` : ''}${
        sp.analyst.analyst ? ` <span class="muted">(${escapeHtml(sp.analyst.analyst)}${sp.analyst.date ? `, ${escapeHtml(sp.analyst.date)}` : ''})</span>` : ''
      }<br><span class="muted">Model alone: ${escapeHtml(blocInfo(p.state, sp.leader).name)}, ${RATING_LABELS[sp.modelRating]}.</span></p>`
    : '';
  const swingNote =
    sp.swingSource === 'state'
      ? '<p class="muted small">This seat has no usable Lok Sabha swing, so it uses the state average.</p>'
      : '';
  return `
    <h3>Battleground 2027</h3>
    <p><strong>${escapeHtml(call)}</strong> · ${RATING_LABELS[sp.rating]} (margin ${sp.margin.toFixed(1)} pts)${
      sp.flip ? ` · <strong>gain from ${escapeHtml(holder)}</strong>` : ` · ${escapeHtml(holder)} hold`
    }</p>
    ${analyst}
    <table class="tally">
      <thead><tr><th>Bloc</th><th class="num">2022 notional</th><th class="num">Projected</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${swingNote}`;
}

function stateLsHtml(ls: LsStateResults): string {
  const tally = ls.summary
    .map((p) => `<span class="chip"><i class="dot" style="background:${partyColor(p.party)}"></i>${escapeHtml(p.party)} ${p.seats}</span>`)
    .join('');
  if (!ls.swingAvailable || ls.nda.change === undefined) {
    return `<h3>2024 Lok Sabha</h3><div class="chips">${tally}</div>
      <p class="muted small">Swing needs 2022 assembly results, which aren't loaded for this state yet.</p>`;
  }
  const pcs = Object.values(ls.pcs).filter((pc) => pc.swing);
  const sorted = [...pcs].sort((a, b) => a.swing!.ndaChange - b.swing!.ndaChange);
  const list = (items: PcResult[]) =>
    items
      .map(
        (pc) => `<li><button class="link" data-pc="${pc.no}">${escapeHtml(pc.name)}</button>
          <span class="muted small">${signed(pc.swing!.ndaChange)} pts · ${escapeHtml(pc.winner?.party ?? '—')} won</span></li>`,
      )
      .join('');
  const members = (y: '2022' | '2024') => ls.nda.members[y].join(' + ');
  return `
    <h3>2024 Lok Sabha</h3>
    <div class="chips">${tally}</div>
    <h3>NDA swing, 2022 → 2024</h3>
    <p>NDA vote share went from <strong>${ls.nda.share2022}%</strong> (2022 assembly) to
    <strong>${ls.nda.share2024}%</strong> (2024 Lok Sabha): <strong>${signed(ls.nda.change!)} pts</strong>.</p>
    <p class="muted small">NDA = ${members('2022')} in 2022; ${members('2024')} in 2024. Measured per Lok Sabha seat,
    because 2024 results by assembly segment aren't available here.</p>
    ${
      ls.nda.excluded?.length
        ? `<p class="callout small">Covers ${ls.nda.pcsCompared} of ${Object.keys(ls.pcs).length} Lok Sabha seats. Left out
           because some of their assembly seats have no boundary data: ${ls.nda.excluded.map(escapeHtml).join(', ')}.</p>`
        : ''
    }
    ${pcs.length > 1 ? `<div class="two-col"><div><h4>Weakest for NDA</h4><ol class="closest">${list(sorted.slice(0, 3))}</ol></div>
    <div><h4>Strongest for NDA</h4><ol class="closest">${list(sorted.slice(-3).reverse())}</ol></div></div>` : ''}`;
}

function selectPc(state: string, pcNo: number) {
  const ls = ls2024.get(state);
  const acs = new Set(ls?.pcs[String(pcNo)]?.acs ?? []);
  const matches = features.filter((f) => f.properties.state === state && acs.has(f.properties.ac_no));
  const bounds = boundsOf(matches);
  if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 9, duration: 800 });
  if (matches[0]) renderConstituency(matches[0].properties);
}

function stateResultsHtml(s: StateInfo, r: StateResults): string {
  const winners = r.summary.filter((p) => p.seats > 0);
  const bar = winners
    .map(
      (p) =>
        `<span style="flex:${p.seats};background:${partyColor(p.party)}" title="${escapeHtml(p.party)}: ${p.seats}"></span>`,
    )
    .join('');
  const rows = winners
    .map(
      (p) => `<tr>
        <td><i class="dot" style="background:${partyColor(p.party)}"></i>${escapeHtml(p.party)}</td>
        <td class="num">${p.seats}</td>
        <td class="num">${p.voteShare.toFixed(1)}%</td>
      </tr>`,
    )
    .join('');
  const closest = Object.values(r.seats)
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 5)
    .map(
      (seat) => `<li><button class="link" data-seat="${seat.no}">${escapeHtml(seat.name)}</button>
        <span class="muted small">${escapeHtml(seat.winner.party)} over ${escapeHtml(seat.runnerUp?.party ?? '—')} by
        ${seat.margin.toLocaleString('en-IN')} votes</span></li>`,
    )
    .join('');

  return `
    <h3>2022 result</h3>
    <div class="seat-bar" aria-hidden="true">${bar}</div>
    <div class="majority-note muted small">Majority mark: ${s.majorityMark}</div>
    <table class="tally">
      <thead><tr><th>Party</th><th class="num">Seats</th><th class="num">Vote share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3>Closest contests</h3>
    <ol class="closest">${closest}</ol>`;
}

function issuesHtml(s: StateInfo): string {
  if (!validation) return `<p class="muted">Loading data-quality checks…</p>`;
  const issues = stateIssues(s.id);
  if (!issues.length) {
    return `<h3>Data quality</h3><p class="ok">✓ All ${s.seats} constituencies matched${
      results.has(s.id) ? ', and every 2022 result joins to its shape' : ' in the boundary source'
    }.</p>`;
  }
  return `<h3>Data quality</h3><ul class="issues">${issues
    .map((i) => {
      const seats = i.values?.filter((n) => n > 0) ?? [];
      return `<li class="${i.severity}"><strong>${i.code}</strong> ${escapeHtml(i.message)}${
        seats.length ? `<br><span class="muted small">Seats: ${seats.join(', ')}</span>` : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

function renderConstituency(p: ConstituencyProps) {
  const s = STATES.find((x) => x.id === p.state)!;
  const seat = seatResult(p);
  const qualityNote =
    p.quality === 'unidentified'
      ? `<p class="callout">⚠ ${qualityLabel(p.quality)}. It needs repairing against official ECI delimitation
         data before a result can be attached to it.</p>`
      : p.quality === 'duplicate'
      ? `<p class="callout">⚠ ${qualityLabel(p.quality)}. The result below is for seat #${p.ac_no}, but this shape
         may not be that constituency.</p>`
      : '';

  panel.detail.innerHTML = `
    <button class="link" id="back">← ${s.name}</button>
    <h2>${escapeHtml(seat?.name ?? (p.ac_name || 'Unnamed shape'))}</h2>
    <dl class="facts">
      <dt>State</dt><dd>${s.name}</dd>
      <dt>AC number</dt><dd>${p.ac_no || '—'}</dd>
      <dt>District</dt><dd>${escapeHtml(p.district ?? '—')}</dd>
      <dt>Lok Sabha seat</dt><dd>${escapeHtml(p.pc_name ?? '—')}</dd>
    </dl>
    ${qualityNote}
    ${seatBattlegroundHtml(p)}
    ${seat ? seatResultHtml(seat) : results.has(p.state) ? '' : `<p class="muted">2022 results for ${s.name} are not loaded yet.</p>`}
    ${pcResult(p) ? pcResultHtml(pcResult(p)!) : ''}
    ${seatNewsHtml(p, s)}`;
  document.getElementById('back')!.addEventListener('click', () => selectState(p.state));
}

function seatResultHtml(seat: SeatResult): string {
  const rows = seat.candidates
    .map(
      (c, i) => `<tr${i === 0 ? ' class="won"' : ''}>
        <td><div>${escapeHtml(c.name)}</div>
          <div class="share-bar"><span style="width:${c.share}%;background:${partyColor(c.party)}"></span></div></td>
        <td>${escapeHtml(c.party)}</td>
        <td class="num">${c.votes.toLocaleString('en-IN')}<div class="muted small">${c.share.toFixed(1)}%</div></td>
      </tr>`,
    )
    .join('');
  return `
    <h3>2022 result</h3>
    <p><strong>${escapeHtml(seat.winner.name)}</strong> (${escapeHtml(seat.winner.party)}) won by
    <strong>${seat.margin.toLocaleString('en-IN')}</strong> votes (${seat.marginPct}%)${
      seat.runnerUp ? ` over ${escapeHtml(seat.runnerUp.name)} (${escapeHtml(seat.runnerUp.party)})` : ''
    }.</p>
    <table class="candidates">
      <thead><tr><th>Candidate</th><th>Party</th><th class="num">Votes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small">${seat.contestants} candidates · ${seat.totalVotes.toLocaleString('en-IN')} votes polled ·
    NOTA ${seat.nota.toLocaleString('en-IN')}</p>`;
}

function pcResultHtml(pc: PcResult): string {
  const outcome = pc.uncontested
    ? `<p><strong>${escapeHtml(pc.winner?.name ?? '')}</strong> (${escapeHtml(pc.winner?.party ?? '')}) was elected unopposed.</p>`
    : `<p><strong>${escapeHtml(pc.winner!.name)}</strong> (${escapeHtml(pc.winner!.party)}) won by
       ${pc.margin!.toLocaleString('en-IN')} votes (${pc.marginPct}%)${
         pc.runnerUp ? ` over ${escapeHtml(pc.runnerUp.name)} (${escapeHtml(pc.runnerUp.party)})` : ''
       }.</p>`;
  const swing = pc.swing
    ? `<h3>Swing, 2022 → 2024</h3>
      <p class="muted small">Vote share across the ${pc.acs.length} assembly seats of ${escapeHtml(pc.name)}: 2022 assembly vs
      2024 Lok Sabha.</p>
      <table class="tally">
        <thead><tr><th>Party</th><th class="num">2022</th><th class="num">2024</th><th class="num">Change</th></tr></thead>
        <tbody>
          <tr class="nda-row"><td>NDA</td><td class="num">${pc.swing.nda2022.toFixed(1)}%</td>
            <td class="num">${pc.swing.nda2024.toFixed(1)}%</td><td class="num">${signed(pc.swing.ndaChange)}</td></tr>
          ${pc.swing.parties
            .map((r) => {
              // A zero share means the party didn't contest here (often seat-sharing), so a
              // party-level change would be meaningless; the NDA row carries the comparison.
              const absent = r.share2022 === 0 || r.share2024 === 0;
              const cell = (v: number) => (v === 0 ? '<span class="muted">—</span>' : `${v.toFixed(1)}%`);
              return `<tr><td><i class="dot" style="background:${partyColor(r.party)}"></i>${escapeHtml(r.party)}</td>
              <td class="num">${cell(r.share2022)}</td><td class="num">${cell(r.share2024)}</td>
              <td class="num ${absent ? 'muted' : r.change >= 0 ? 'up' : 'down'}">${absent ? 'n/a' : signed(r.change)}</td></tr>`;
            })
            .join('')}
        </tbody>
      </table>
      <p class="muted small">— = did not contest. Seat-sharing changes which party stands for an alliance, so compare
      the NDA row rather than single parties where that happens.</p>`
    : '';
  const incomplete = pc.swingIncomplete
    ? `<p class="muted small">No swing shown: only ${pc.acs.length} of this Lok Sabha seat's assembly seats have
       boundary data, so a 2022 comparison would be partial.</p>`
    : '';
  return `<h3>2024 Lok Sabha · ${escapeHtml(pc.name)}</h3>${outcome}${swing}${incomplete}`;
}

// Stories tagged to this seat directly, or to the district it sits in.
function seatNews(p: ConstituencyProps): NewsItem[] {
  return news.filter((n) =>
    n.places.some(
      (pl) => pl.state === p.state && (pl.kind === 'ac' ? pl.ac === p.ac_no : pl.acs?.includes(p.ac_no)),
    ),
  );
}

// Stories naming the seat or its district; when there are none, the latest from the state so
// the seat view is never a dead end.
function seatNewsHtml(p: ConstituencyProps, s: StateInfo): string {
  const direct = seatNews(p);
  if (direct.length) return newsHtml(direct, 'News for this seat', '');
  const stateNews = news.filter((n) => n.states.includes(p.state)).slice(0, 4);
  return newsHtml(
    stateNews,
    'News for this seat',
    `No news for ${escapeHtml(s.name)} yet.`,
    `No stories name this seat or its district yet. Latest from ${escapeHtml(s.name)}:`,
  );
}

const TOPIC_LABELS: Record<string, string> = {
  schedule: 'Schedule & EC',
  alliances: 'Alliances',
  candidates: 'Candidates',
  campaign: 'Campaign',
  polls: 'Opinion polls',
  defections: 'Defections',
  governance: 'Governance',
  security: 'Security',
  legal: 'Legal',
  other_polls: 'By-polls & local polls',
  analysis: 'Analysis',
  other: 'Other',
};

function newsHtml(items: NewsItem[], heading: string, empty: string, intro = ''): string {
  const submit = `<p class="small"><a href="${NEWS_TIP_URL}" target="_blank" rel="noopener noreferrer">Submit a news tip</a>
    <span class="muted">· reviewed by a moderator before it appears</span></p>`;
  if (!items.length) return `<h3>${heading}</h3><p class="muted small">${empty}</p>${submit}`;
  const date = (n: NewsItem) =>
    n.published
      ? new Date(n.published).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'date unknown';
  const rows = items
    .map((n) => {
      const places = n.places
        .map(
          (pl) =>
            `<span class="tag ${pl.confidence}" title="${pl.confidence} confidence · via ${pl.via.join(' + ')}">${escapeHtml(pl.name)}${
              pl.kind === 'district' ? ' (district)' : ''
            }</span>`,
        )
        .join('');
      return `<li>
        <a href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>
        <div class="muted small">${escapeHtml(n.source ?? 'Unknown source')} · ${date(n)} ·
          <span class="topic">${TOPIC_LABELS[n.topic] ?? escapeHtml(n.topic)}</span></div>
        ${n.summary ? `<div class="small">${escapeHtml(n.summary)}</div>` : ''}
        ${places ? `<div class="tags">${places}</div>` : ''}
        ${
          n.tagger === 'crowd'
            ? `<div class="small crowd">Community tip${n.contributor ? ` by @${escapeHtml(n.contributor)}` : ''}${
                n.crowdIssue ? ` · <a href="${escapeHtml(n.crowdIssue)}" target="_blank" rel="noopener noreferrer">reviewed submission</a>` : ''
              }</div>`
            : ''
        }
      </li>`;
    })
    .join('');
  const tagger = items.some((n) => n.tagger === 'claude')
    ? 'Tagged by Claude; constituency tags are checked against the official seat list.'
    : 'Refreshed daily. States, places and topics are tagged by keyword rules maintained by the analyst; tags can occasionally be wrong.';
  return `<h3>${heading}</h3>${intro ? `<p class="muted small">${intro}</p>` : ''}<ul class="news">${rows}</ul>
    <p class="muted small">${tagger}</p>${submit}`;
}

function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(1)}`;
}

function resetView() {
  selectedState = null;
  map.fitBounds(INDIA_BOUNDS, { duration: 800 });
  renderStateList();
  renderOverview();
  renderLegend();
}

function renderLegend() {
  const item = (color: string, label: string) => `<span><i style="background:${color}"></i>${escapeHtml(label)}</span>`;
  let items: string[];
  if (colorMode === 'state') {
    items = [...STATES.map((s) => item(STATE_COLORS[s.id], s.id)), item(ISSUE_COLOR, 'Data issue')];
  } else if (colorMode === 'margin') {
    items = [...MARGIN_BUCKETS.map(([, c, label]) => item(c, label)), item(NO_DATA_COLOR, 'No 2022 data')];
  } else if (colorMode === 'battleground') {
    // Blocs from the selected state, or from every state when none is selected.
    const ids = selectedState ? [selectedState] : [...battleground.keys()];
    const seen = new Map<string, string>();
    for (const id of ids) for (const b of battleground.get(id)?.blocs ?? []) if (!seen.has(b.name)) seen.set(b.name, b.color);
    items = [
      `<span class="legend-title">Projected 2027 call · paler = less safe · outlined = changes hands</span>`,
      ...[...seen].slice(0, 8).map(([name, color]) => item(color, name)),
      item(TOSSUP_COLOR, 'Toss-up'),
      item(NO_DATA_COLOR, 'No data'),
    ];
  } else if (colorMode === 'swing') {
    items = [
      `<span class="legend-title">NDA vote share change, pts</span>`,
      ...SWING_BUCKETS.map(([, c, label]) => item(c, label)),
      item(NO_DATA_COLOR, 'No data'),
    ];
  } else {
    // Parties that won at least one seat anywhere, most seats first.
    const seats = new Map<string, number>();
    const tallies =
      colorMode === 'winner' ? [...results.values()].map((r) => r.summary) : [...ls2024.values()].map((r) => r.summary);
    for (const summary of tallies) for (const p of summary) seats.set(p.party, (seats.get(p.party) ?? 0) + p.seats);
    const winners = [...seats].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const named = winners.filter(([p]) => p in PARTY_COLORS && p !== 'IND').slice(0, 8);
    items = [
      ...named.map(([p]) => item(PARTY_COLORS[p], p)),
      item(PARTY_COLORS.IND ?? OTHER_PARTY_COLOR, 'IND'),
      item(OTHER_PARTY_COLOR, 'Other'),
      item(NO_DATA_COLOR, colorMode === 'winner' ? 'No 2022 data' : 'No data'),
    ];
  }
  panel.legend.innerHTML = items.join('');
}

function partyColor(abbr: string): string {
  return PARTY_COLORS[abbr] ?? OTHER_PARTY_COLOR;
}

function qualityLabel(q: ConstituencyProps['quality']): string {
  return q === 'unidentified' ? 'Unidentified shape (no valid seat number)' : 'Seat number shared by multiple shapes';
}

function boundsOf(fs: Feature[]): LngLatBoundsLike | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else (c as unknown[]).forEach(visit);
  };
  for (const f of fs) if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

async function loadBasemapStyle(): Promise<maplibregl.StyleSpecification | string> {
  try {
    const res = await fetch(BASEMAP_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return BASEMAP_URL;
  } catch {
    // fall through to the offline style
  }
  console.warn('Basemap unavailable; using plain background.');
  return FALLBACK_STYLE;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
