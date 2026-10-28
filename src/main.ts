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

type ColorMode = 'winner' | 'margin' | 'ls2024' | 'swing' | 'state';

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
let news: NewsItem[] = [];
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
  const [collections, report, stateResults, lsResults, newsData] = await Promise.all([
    Promise.all(STATES.map((s) => fetchJson<GeoJSON.FeatureCollection>(`data/boundaries/${s.id}.geojson`))),
    fetchJson<ValidationReport>('data/validation.json'),
    // Results are optional per state (Gujarat and Himachal are not sourced yet).
    Promise.all(STATES.map((s) => fetchJson<StateResults>(`data/results/2022-${s.id}.json`).catch(() => null))),
    Promise.all(STATES.map((s) => fetchJson<LsStateResults>(`data/ls2024/${s.id}.json`).catch(() => null))),
    fetchJson<{ items: NewsItem[] }>('data/news.json').catch(() => ({ items: [] })),
  ]);
  news = newsData.items;
  validation = report;
  for (const r of stateResults) if (r) results.set(r.state, r);
  for (const r of lsResults) if (r) ls2024.set(r.state, r);

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
  map.addLayer({
    id: 'ac-issue-line',
    type: 'line',
    source: 'acs',
    filter: ['!=', ['get', 'quality'], 'ok'],
    paint: { 'line-color': ISSUE_COLOR, 'line-width': 1.5 },
  });

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
      map.setPaintProperty('ac-fill', 'fill-color', fillColorExpression());
      renderLegend();
    }),
  );
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
    (pc?.swing ? `<div>NDA swing: ${signed(pc.swing.ndaChange)} pts</div>` : '');
  const flag = p.quality !== 'ok' ? `<div class="tip-flag">⚠ ${qualityLabel(p.quality)}</div>` : '';
  return `<strong>${escapeHtml(name)}</strong> <span class="muted">${no}</span><br>${escapeHtml(p.district ?? '')}${result}${flag}`;
}

function selectState(id: string) {
  selectedState = id;
  const bounds = boundsOf(features.filter((f) => f.properties.state === id));
  if (bounds) map.fitBounds(bounds, { padding: 32, duration: 800 });
  renderStateList();
  renderStateDetail(id);
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
    ${newsHtml(news.slice(0, 5), 'Latest news', 'No news collected yet.')}`;
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
    ${seat ? seatResultHtml(seat) : results.has(p.state) ? '' : `<p class="muted">2022 results for ${s.name} are not loaded yet.</p>`}
    ${pcResult(p) ? pcResultHtml(pcResult(p)!) : ''}
    ${newsHtml(seatNews(p), 'News for this seat', 'No news tagged to this seat or its district yet.')}`;
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

const TOPIC_LABELS: Record<string, string> = {
  schedule: 'Schedule',
  alliances: 'Alliances',
  candidates: 'Candidates',
  campaign: 'Campaign',
  polls: 'Opinion polls',
  defections: 'Defections',
  governance: 'Governance',
  security: 'Security',
  legal: 'Legal',
  other: 'Other',
};

function newsHtml(items: NewsItem[], heading: string, empty: string): string {
  if (!items.length) return `<h3>${heading}</h3><p class="muted small">${empty}</p>`;
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
      </li>`;
    })
    .join('');
  const tagger = items.some((n) => n.tagger === 'rules')
    ? 'Some stories are tagged by keyword rules only; AI tagging runs when the weekly job has API credentials.'
    : 'Tagged by Claude; constituency tags are checked against the official seat list.';
  return `<h3>${heading}</h3><ul class="news">${rows}</ul><p class="muted small">${tagger}</p>`;
}

function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(1)}`;
}

function resetView() {
  selectedState = null;
  map.fitBounds(INDIA_BOUNDS, { duration: 800 });
  renderStateList();
  renderOverview();
}

function renderLegend() {
  const item = (color: string, label: string) => `<span><i style="background:${color}"></i>${escapeHtml(label)}</span>`;
  let items: string[];
  if (colorMode === 'state') {
    items = [...STATES.map((s) => item(STATE_COLORS[s.id], s.id)), item(ISSUE_COLOR, 'Data issue')];
  } else if (colorMode === 'margin') {
    items = [...MARGIN_BUCKETS.map(([, c, label]) => item(c, label)), item(NO_DATA_COLOR, 'No 2022 data')];
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
