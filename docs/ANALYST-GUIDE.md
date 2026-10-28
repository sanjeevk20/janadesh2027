# Analyst guide: Battleground 2027 inputs

The battleground view combines **data** (2022 assembly and 2024 Lok Sabha results, handled by the engineering pipeline) with **judgement** (alliances, scenarios and seat calls, owned by you, the voting research analyst). This guide covers the judgement side: three JSON files in [`data/analyst/`](../data/analyst/).

You don't need to run anything locally. Edit a file on GitHub (pencil icon → edit → "Propose changes"), open a pull request, and once it's merged the site rebuilds and redeploys within a few minutes. The build checks your inputs and fails with a clear message if something doesn't add up, so a typo can't silently change a projection.

Party codes (`BJP`, `SP`, `INC`, `AD(S)`, …) are the abbreviations in [`data/parties.json`](../data/parties.json).

---

## 1. Alliances: `blocs.json`

Defines who contests together in 2027 in each state. This is the most consequential input: the model regroups 2022 and 2024 votes into these blocs, so it changes every baseline, swing and projection.

```json
"UP": {
  "confirmed": false,
  "blocs": [
    { "id": "NDA",   "name": "NDA",            "color": "#f47c20", "parties": ["BJP", "AD(S)", "RLD", "SBSP", "NISHAD"] },
    { "id": "INDIA", "name": "INDIA (SP+INC)", "color": "#d7191c", "parties": ["SP", "INC"] },
    { "id": "BSP",   "name": "BSP",            "color": "#5b3fa8", "parties": ["BSP"] }
  ],
  "note": "Assumes RLD and SBSP stay with the NDA as in 2024, and SP–INC contest together."
}
```

- **`id`** is used by scenarios and ratings; keep it short and stable.
- A party may appear in **only one** bloc. Parties not listed count as *Others*: the strongest one in each seat keeps its 2022 share and can still win, but gets no swing.
- **`note`** is shown on the page next to the projection; use it to state your assumption.
- **`confirmed`**: every state starts as `false`, with a banner saying the alliances are provisional. Set it to `true` once you've reviewed the state.

The current values are **engineering defaults based on 2024 alignments**, not analyst judgements. Please review every state.

## 2. Scenarios: `scenarios.json`

Named swings that appear in the "Analyst scenario" picker. Each one sets the sliders: points added to a bloc's vote share in every seat.

```json
"UP": [
  {
    "id": "anti-incumbency-mild",
    "name": "Mild anti-incumbency: NDA −3, INDIA +2",
    "swing": { "NDA": -3, "INDIA": 2 },
    "note": "Based on <source>, <date>.",
    "author": "Your name"
  }
]
```

- Scenarios add to the chosen **base**: either the 2022 notional result, or that plus each Lok Sabha seat's 2024 swing. The person viewing picks the base, so write the note to say which base you intended.
- Blocs you leave out get 0.
- The UP entry `example-india-gain` is a placeholder. Replace or delete it.

## 3. Seat calls: `ratings.json`

Your call on a specific seat. It overrides the model in the seat view, the map colour and the tally, and is labelled "analyst" wherever it appears. The model's own call is still shown underneath for comparison.

```json
"UP": {
  "20": {
    "rating": "lean",
    "bloc": "INDIA",
    "note": "Sitting MLA switched to SP in Sept; strong local Jat consolidation.",
    "analyst": "Your name",
    "date": "2026-11-02"
  }
}
```

- The key is the **assembly constituency number** (shown as "AC number" in the seat view).
- **`rating`** is one of `safe`, `likely`, `lean` or `tossup`.
- **`bloc`** is required unless the rating is `tossup`.
- Date your calls. Ratings go stale, and the date is shown on the page.

## 4. News cues: `news-cues.json`

The daily news tagger runs on keyword rules (no AI key is configured). The domain knowledge behind it is yours to maintain:

- **`stateCues`**: names that place a story in a state, such as leaders ("Akhilesh", "Bhagwant Mann"), nicknames ("UP", matched case-sensitively so the word "up" doesn't count) and regions ("Saurashtra"). Add new leaders as they emerge.
- **`multiStateCues`**: phrases like "five states" that mean the Round 1 states.
- **`ambiguousPlaceNames`**: seat names that are also common personal names ("Anand"). They only count when the story is already about that state.
- **`referencePatterns`**: headline patterns for seat-profile pages and old results, which are archived but not published.
- **`topicRules`**: keywords for each topic, checked in order; the first match wins.

Patterns are regular expressions. After a change, run `npm run news:eval` or ask engineering to. It reports accuracy on a held-out set of labelled stories, which shouldn't drop. If you notice a mis-tagged story on the site, add it to `data/news/eval.json` with the correct labels. That's the most useful feedback for improving the rules.

---

## How the model works

1. **Notional 2022:** each seat's 2022 votes are summed into your 2027 blocs.
2. **Base swing (optional):** for each Lok Sabha seat, the change in each bloc's share from the 2022 assembly vote (across its assembly seats) to the 2024 Lok Sabha vote. Every assembly seat in that Lok Sabha seat gets the same swing. Where no usable Lok Sabha swing exists (an uncontested seat, or missing boundary data), the state average is used.
3. **Adjustments:** your scenario or slider points are added to every seat.
4. **Call:** the bloc with the highest projected share leads. The margin over the runner-up gives the rating: toss-up under 2 points, lean under 5, likely under 10, safe above that. Your seat ratings replace this where you've set one.
5. **Changes hands:** the call differs from the bloc of the 2022 winner, under 2027 alliances.

**Known limits, worth stating whenever the projection is cited:**
- Uniform swing ignores candidate effects, turnout changes and local factors. That's what seat ratings are for.
- Lok Sabha and assembly votes behave differently. In Manipur especially, the 2024 Lok Sabha contest was so different from 2022 that the "+ 2024 swing" base is unreliable.
- Twenty Gujarat seats have no map shape. They're counted in the tally and lists but can't be coloured on the map.
