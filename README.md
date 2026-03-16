# CounterPlot

A two-player AI narrative duel. Each player writes their intent for the scene; a Gemini GM resolves the turn, generates scene text and a cinematic still image, then Veo automatically animates it into a motion clip. First to 100% narrative control wins.

---

## How it works

Two players share a story. On each turn, the active player writes a **Scene Direction** and **Constraints** in the intent editor, picks a goal tone, and submits. The GM (Gemini) resolves both players' competing intents into a scene — narration, a visual panel, and a progress update. After 10 turns the story ends with one of two player-defined endings.

**Core loop**

1. Player writes intent (Markdown-style editor)
2. GM generates: scene text → image (Gemini image model) → motion clip (Veo 2, auto-triggered)
3. Progress bar shifts toward A or B based on narrative causality
4. Opponent's turn begins
5. Repeat for 10 turns → game over

**Motion clips** — after each image is committed, a Veo 2 `image_to_video` job starts automatically in the background. Once ready, hovering the turn frame plays the 5-second clip. The "hover to play" hint disappears after the first hover.

**Multiplayer** — the host creates a room and shares two join links (one per seat). State is synced in real time via Socket.IO with per-seat token auth. Solo mode runs everything locally without a second player.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 |
| Backend | Node.js (ESM), Express, Socket.IO |
| Text / Image AI | Google Gemini (`gemini-2.5-flash`, `gemini-2.5-flash-image`) via `@google/genai` |
| Motion AI | Google Veo 2 (`veo-2.0-generate-001`) via Vertex AI |
| Real-time | Socket.IO rooms with token-gated seats |

---

## Prerequisites

- **Node.js** 18+
- **Gemini API key** — [get one at Google AI Studio](https://aistudio.google.com/apikey)
- *(Optional)* **GCP project with Vertex AI enabled** — required only for motion clip generation

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example and fill in your keys:

```bash
cp .env.example .env
```

Minimum required (text + image generation):

```env
GEMINI_API_KEY=your_gemini_api_key
```

To also enable motion clips (Veo 2):

```env
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account-key.json

# Optional — defaults shown
VEO_LOCATION=us-central1
VEO_MODEL=veo-2.0-generate-001
```

> On Cloud Run, use Workload Identity instead of `GOOGLE_APPLICATION_CREDENTIALS`.

### 3. Run

You need **two terminals**:

**Terminal 1 — backend**
```bash
npm run server
# → Server running at http://localhost:3001
```

**Terminal 2 — frontend**
```bash
npm run dev
# → Local: http://localhost:3000
```

Open `http://localhost:3000`.

---

## Project structure

```
CounterPlot/
├── src/
│   ├── App.tsx              # Main app — all views, game loop, motion clip state
│   ├── types.ts             # GameState, TurnData, Panel
│   ├── storyPacks.ts        # Story definitions (scenarios, player goals, side quests)
│   ├── outcomeEngine.ts     # Progress / momentum / streak / phase logic
│   ├── store.ts             # Local and socket-synced game state hooks
│   └── server/
│       └── gemini.ts        # Gemini API calls (text, image, cover, translation)
├── server/
│   ├── index.mjs            # Express + Socket.IO server, room management
│   └── veo.mjs              # Veo image-to-video pipeline (async job queue)
├── generated/               # Runtime output — scene images, motion clips (git-ignored)
├── public/
│   └── covers/              # Story pack cover images
├── .env.example
└── package.json
```

---

## Game mechanics

### Intent editor

Each turn the active player fills in:

- **Scene Direction** — what you want to happen narratively
- **Constraints** — rules or limits you impose on the scene
- **Goal** — one of: `Advance`, `Defend`, `Pivot`, `Reveal`, `Escalate`
- **Tone** — one of: `Subtle`, `Direct`, `Provocative`

### Progress bar

Ranges from 0 (full Player B control) to 100 (full Player A control). The GM evaluates narrative causality each turn and shifts the bar. Each player is trying to steer the story toward their own defined ending.

### Outcome engine

Tracks momentum, streak, and phase across turns. Penalties apply for intents that are ruled inapplicable by the GM.

### Side quests

Each player has a secret objective hinted at in their role description. Completing it mid-game awards a one-time progress bonus.

### Credibility

A shared resource that decays when the GM rules intents inapplicable. Affects narrative weight of future turns.

---

## Motion clips

After each turn image is generated:

1. A `POST /api/motion-clip` job is enqueued automatically — no user action needed
2. The backend calls Veo 2 (`image_to_video`, 5 seconds) and polls until done (~2–5 min)
3. The clip is saved to `generated/clips/` and served as static content
4. The frontend polls every 10 seconds and updates the turn card when ready
5. Hover the image frame to play the clip; the hint disappears after first hover

If Veo is not configured (`GOOGLE_CLOUD_PROJECT` unset), motion generation is silently skipped and the static image is shown instead.

---

## Story packs

| ID | Title | Tags |
|---|---|---|
| `neon-shadow` | Neon Shadow | Cyberpunk, Infiltration, Mystery |
| `echoes-of-the-abyss` | Echoes of the Abyss | Deep-Sea Horror, Sci-Fi, Psychological |

More packs can be added in `src/storyPacks.ts`.

---

## Multiplayer

1. Host opens the app → **Create Duel** → picks a story pack → server creates a room
2. Two join URLs are generated (`?player=A&session=...&token=...` / `?player=B&...`)
3. Share each URL with the respective player
4. Both players connect; Socket.IO keeps state in sync with turn-order enforcement

The server enforces that only the player whose turn it currently is may push state.

---

## Available scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Vite dev server (port 3000) |
| `npm run server` | Start Express + Socket.IO backend (port 3001) |
| `npm run build` | Production build |
| `npm run lint` | TypeScript type check |
| `npm test` | Run Vitest unit tests |
| `npm run playtest` | Run automated playtest script |

---

## Notes

- `generated/` is created at runtime and should be added to `.gitignore`
- Motion clips are not persisted across server restarts (in-memory job map)
- The Veo pipeline requires a GCP service account with `roles/aiplatform.user`
- The app runs fully without Veo — motion generation degrades gracefully to static images
