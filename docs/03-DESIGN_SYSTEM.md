# 03 — Design System and Live AI Interface

## 1. Reference analysis and visual thesis

### What the references show

| Reference | Principle to borrow | What not to copy |
| --- | --- | --- |
| FounderOS 20-screen board | Module set and order; dense but readable mobile screens; a metric, briefing and priorities stack on Home; approval cards with explicit Allowed / Approval required / Blocked lists; an agent grid with per-agent colour; the "Adaptive Agent Presence" idea | Violet on every surface and button, gradient pill buttons, glow borders around every card, the FounderOS name and logo, fabricated KPI numbers |
| Reel — violet listening | One luminous point inside a thin ring; ribbons orbit **outside** the ring; a vertical mono "LISTENING" rail on the left edge; tiny HUD metadata on the right; near-black space with a few particles | The third-party artwork itself; the clock/weather HUD (not Qline's job) |
| Reel — amber/teal processing | **The ring colour changes by state** (warm ring = working) while the core keeps its hue; strands cross over the core vertically; the rail label changes ("PROCESSING") | — |
| Reel — amber/teal listening | Same scene, calmer: a wider outer halo, slower strands. State is shown by **tempo and spread**, not by new objects | — |

### Qline visual thesis

**"A quiet instrument panel around one living signal."** Qline is where an owner runs a real business, so the chrome is calm, precise and readable for hours. That calm makes the single living element, the agent core, feel alive. The core is the only place glow and motion live. Everything else is flat spruce ink with crisp hairlines and dense, honest data.

- **Mood:** observatory at night: technical, composed, warm-touched.
- **Brand signal:** **Halo**, citrine `#F5C451` since v1.6 (originally ivory-gold `#EBCB8B`, then mint `#5EF2C6` in v1.2). It is taken from the ring in the reel frames and stands for *human attention and approval*. Halo is used for primary buttons, approval moments and the logo ring. **Agents never use Halo**, so a Halo element always means "you, the human, decide here".
- **Agent hues** carry identity only inside agent surfaces (core, avatar ring, run tags): violet CEO, sky Sales, lime Finance, teal Operations, magenta Marketing, periwinkle Research (v1.6 values in §2).
- **Density:** medium-high. The data lists use 56 dp rows, and cards are used only for grouping (briefing, approval, proposal diff), not around every element.
- **Signature details:** (1) the **vertical state rail** (mono, letter-spaced, beside the core) is reused across the app as a thin left "status spine" on running items; (2) the **Q-line mark**: a ring with a short tangent stroke that leaves it at about 4 o'clock, which is the shape of a "Q" and a "line".

**Non-goals:** no purple-to-blue gradients on buttons or backgrounds, no glassmorphism on content cards, no neon borders, no decorative bento grid on Home, no fake metrics or avatars presented as real, and no animation outside the core, progress and state transitions.

## 2. Tokens

### Colour — "Citrine Signal on Spruce Ink" (v1.6)

v1.6 replaces "Mint Signal on Violet Ink" (v1.2), which itself replaced the original graphite + gold. Surfaces are deep spruce, a blue-green ink, and the one signal colour is citrine. The palette is deliberately distinct from Jazz's other products: FlowPilot "Cobalt Graphite", Chrono "Ember on Ink" and Sapphire's blue. The source of truth is `QColors` in `apps/mobile/lib/ui/theme.dart`. The ratios below were computed with the WCAG 2.x relative-luminance formula.

### Colour — dark (default)

| Token | Value | Use | Contrast on `bg` |
| --- | --- | --- | --- |
| `bg` | `#07100F` | App background (ink, not pure black) | — |
| `surface-1` | `#0D1816` | Grouped sections, sheets, chart frames | — |
| `surface-2` | `#14221F` | Inputs, raised rows, chips | — |
| `line` | `#22332F` | Hairlines, dividers, chart grid | decorative only |
| `line-strong` | `#56716A` | Input and control borders | 3.6:1 (3.1:1 on `surface-2`) |
| `text` | `#ECF3EF` | Primary text | 17.1:1 |
| `text-2` | `#AABBB5` | Secondary text | 9.6:1 |
| `text-3` | `#879A93` | Meta, timestamps (≥ 11 px) | 6.5:1 (5.5:1 on `surface-2`) |
| `halo` | `#F5C451` (citrine) | Primary action fill, approvals, brand mark | 11.8:1 |
| `on-halo` | `#1C1500` | Text on Halo | 11.2:1 on halo |
| `ok` | `#7EDC8A` | Success (always with ✓ icon + word) | 11.5:1 |
| `warn` | `#FF9F4A` | Needs attention (with ! icon); orange, so it never reads as Halo | 9.5:1 |
| `bad` | `#FF6F80` | Errors, blocked (with × icon) | 7.2:1 |
| `info` | `#8FB4FF` | Neutral info | 9.3:1 |
| `liveInk` | `#050C0B` | Live AI, launch screen, Android window background | — |

### Colour — light

| Token | Value |
| --- | --- |
| `bg` | `#F3F6F4` (pale spruce paper) |
| `surface-1` | `#FFFFFF` |
| `surface-2` | `#E5ECE9` |
| `line` / `line-strong` | `#D1DCD8` (decorative) / `#6C7F79` (controls, 3.9:1) |
| `text` / `text-2` / `text-3` | `#0E1716` (16.7:1) / `#3C4B47` (8.4:1) / `#55645F` (5.7:1 on bg, 5.2:1 on `surface-2`) |
| `halo` | `#7A5900` (deep citrine) for fills and text on light (5.9:1); `on-halo` `#FFFFFF` (6.4:1) |
| `ok` / `warn` / `bad` / `info` | `#2D7333` (5.3:1) / `#9A4A00` (5.8:1) / `#B3263E` (5.9:1) / `#2C52B5` (6.5:1) |

### Charts in chat (v1.6)

Data uses flat, solid colours: `#8FB4FF`, `#7EDC8A`, `#FF9F4A`, `#F07AC0`, `#B08CFF` and `#36CDBE` (`chartColors` in `lib/ui/chat_artifacts.dart`). Citrine is never a series colour, because it means "you decide". Every chart shows:

- its title;
- a legend when there are several series;
- a source line: "Computed by Qline from your data" for server-computed charts, or "From: … · provided by the AI".

Screen readers get the values as text. Reduce motion skips the grow-in animation.

The Live AI screen stays dark in both themes. It is an immersive surface, the same way camera viewfinders stay dark, and its text still uses the dark tokens.

### Agent identity

| Agent | Core hue | Ring (idle) | Character of motion |
| --- | --- | --- | --- |
| AI CEO / Chief of Staff | Violet `#B08CFF` | ivory | Slow, wide orbit; strands sweep like a horizon (strategic) |
| Sales | Sky `#3DB8FF` | ivory | Quicker pulse; strands lean forward (responsive) |
| Finance | Lime `#B9E25A` (amber was retired in v1.6 because it was too close to citrine Halo) | ivory | Tight, evenly spaced rings; minimal wobble (precise) |
| Operations | Teal `#36CDBE` | ivory | Steady metronome rotation (steady) |
| Marketing | Magenta `#F07AC0` | ivory | Ribbons with more curl (expressive) |
| Research | Periwinkle `#8EA2FF` | ivory | Particles drift in layers like scan lines (analytical) |
| Custom | User-chosen from a 12-hue wheel that is contrast-checked and excludes Halo | ivory | Default motion |

The agent's name and role are always shown as text. Colour is never the only cue, which matters for colour-blind users.

### Typography

- **UI / headings:** *Hanken Grotesk* (Google Fonts, OFL), weights 400/500/600/700. It has open counters and good small sizes, without being overused like Inter. In Flutter it is bundled as an asset, not fetched at runtime.
- **Data / HUD:** *JetBrains Mono* (OFL) for the state rail, IDs, timestamps in logs and numbers in tables (tabular figures).
- **Scale (mobile):** 12 meta · 14 body-s/buttons · 16 body · 18 title-s · 22 title · 28 display (only for the Welcome screen and Command Center greeting). Line height 1.4 body, 1.2 titles.

### Shape, space, elevation

- 4/8 dp spacing grid; 16 dp screen gutters; 24 dp between sections.
- Radii: 10 (inputs/chips) · 14 (cards/sheets) · 999 (only the core button and avatars).
- No drop shadows in dark mode. Elevation is shown as a lighter surface plus a hairline. Light mode uses one soft shadow (`0 1px 2px rgba(20,23,28,.06), 0 4px 16px rgba(20,23,28,.05)`).
- Touch targets ≥ 48 dp. The bottom nav is 64 dp plus the system inset; the core button is 56 dp.

### Motion

| Use | Duration | Curve |
| --- | --- | --- |
| Press feedback | 120 ms | scale 0.97, spring back |
| Chip / toggle | 160 ms | standard |
| Sheet / card expand | 320 ms | emphasized decelerate |
| Screen transition | 300 ms | shared-axis X (tabs), fade-through (modal) |
| Core state change | 600–900 ms crossfade of parameters | ease-in-out; never a hard cut |

**Reduced motion:** the core renders one static frame per state, rail labels still change, and transitions become 120 ms fades. **Battery:** the core pauses when the screen is not visible and drops to 30 fps on battery saver.

## 3. Logo — the Q-line mark

The mark is an open ring whose tail starts inside the ring and leaves it at about 4 o'clock, which reads as a "Q" and as a "line". It is drawn by `QMark` (`lib/ui/core_painter.dart`) in `currentColor`: Halo on dark, ink on light. Its exact geometry, in a unit square:

- **Ring:** centre (.46, .46), radius .36, stroke .10, an arc from 0.9 rad sweeping 5.6 rad.
- **Tail:** from the centre + (.35r, .35r) to (.92, .92).
- **Caps:** round.

Since v1.6 the launcher icon uses the same geometry. Earlier icons showed a closed ring with a centre dot, which did not match the app. `apps/mobile/tool/make_icons.py` draws a citrine mark with a soft static glow on a spruce-ink background that lifts slightly at the centre, and writes:

- the legacy icons at every density;
- the adaptive foreground and background layers, with the mark inside the 66 dp safe zone;
- a monochrome layer for themed icons;
- a 512 px store icon;
- the SVG source, `tool/brand/qmark.svg`.

The website and favicon (`apps/site`) use the same path. The wordmark is "Qline" in Hanken Grotesk 700 with tight tracking.

## 4. Layout patterns

- **Command Center:** greeting + date → **Today's briefing** card (3 source-linked bullets) → **Waiting on you** (approvals, max 3 + "See all") → **Priorities** (tasks due/overdue) → **Numbers** (only configured metrics, each with its source label, for example "from clients.csv · imported 15 Nov") → **Agent activity** (last 3 runs).
- **List rows:** leading status glyph · title (1 line, ellipsis) · meta (text-3) · trailing value/avatar. The swipe actions are complete and assign, and each has a menu equivalent.
- **Approval card:** the requester's agent chip (hue dot + name + role), action verb, target, preview, **risk** (Low/Medium/High as a word + icon), and the reason ("why"). The actions are **Approve** (Halo fill), **Edit** (outline) and **Reject** (text, destructive colour).
- **Proposal diff:** grouped by category (Modules, Fields, Pipeline, Agents, Workflows, Knowledge). Each item shows + / ~ / − badges and can be toggled. A sticky footer shows "Apply 23 changes".

## 5. Component inventory (shared tokens on mobile and web)

| Component | Variants | Interaction spec |
| --- | --- | --- |
| Top bar | default, search-active, offline banner | The switcher opens sheet X1; the approvals badge shows a count up to 99+ |
| Bottom nav | 5 items, centre core | The centre button shows a mini core in the active agent's hue; long-press opens the agent picker |
| Button | primary (Halo), secondary (outline), ghost, destructive | Press scale 0.97; the loading state keeps the label width; disabled at 40% opacity with a reason tooltip |
| Input / select | text, multiline, search, money (currency-aware), date | Label above; error below with a recovery hint; 48 dp height |
| Chip | filter, choice, status | 32 dp visual height, 48 dp hit area |
| Status pill | Not configured · Connected · Needs attention · Disconnected · Planned · Sample | Icon + word, never colour alone |
| Card | briefing, approval, proposal group, metric | Used only for grouping |
| List row | task, record, document, memory, run | Swipe + overflow menu |
| Sheet | bottom sheet (mobile), side panel (web) | Drag handle; Esc / back closes; focus is trapped |
| Agent chip | hue dot + name + role | — |
| Provenance tag | Verified · You said · Imported · Inferred · Outdated | Tap shows the source and timestamp |
| Status spine | 3 px left rule on running items, agent hue; pulses only while running | — |
| Agent core | full (Live AI), mini (nav, 24 dp), presence (roster, 64 dp) | See §6 |
| Composer | text, mic (push-to-talk), attach, record reference (@) | Grows to 6 lines; keyboard-safe; Send turns into Stop while streaming |
| Tool timeline | plan → call → result → approval | Collapsible; each step shows the tool name, a summary and the duration |
| Empty state | icon-free, a one-line explanation + one action | For example "No clients yet — Import a CSV" |
| Skeleton | list, card | Only for loads longer than 300 ms |

## 6. Live AI interface (A1)

### Layout (portrait)

```
┌──────────────────────────────────────┐
│ ←  ● AI CEO · Chief of Staff  ▾   ⋯  │  agent picker; ⋯ = history, voice settings
│    Acme Studio · Sample workspace     │  workspace context
│ L                                     │
│ I         ◯  energy core  ◯           │  centre 60% of the height above the sheet
│ S                                     │
│ T                                     │
│ E                                     │
│ N    "What's overdue this week?"      │  live transcript (editable)
│──────────────────────────────────────│
│ ▸ Tool timeline (2 steps)             │  collapsible
│ Assistant response streaming…  [Stop] │
│ [Summarise today] [Draft follow-up]   │  grounded suggestions
│ [＋] [ Message AI CEO…       ] [🎙]   │  composer = equal to voice
└──────────────────────────────────────┘
```

### State system

| State | Core (centre) | Ring | Strands / particles | Rail label | Other UI |
| --- | --- | --- | --- | --- | --- |
| Idle | Agent hue, soft breathing (4 s) | Ivory, thin | Slow orbit, sparse | READY | Suggestions visible |
| Listening | Brighter; scales with the mic level | Ivory, a wider halo appears | Calmer, spread out (reel 3) | LISTENING | Red recording dot + "Listening — tap to stop"; live transcript |
| Thinking | Particles converge inward | Ivory with a slow dashed inner orbit | Strands speed up and cross vertically | THINKING | Stop button |
| Tool use | Hue steady | **Warm amber ring** (reel 2) | 1–3 satellite dots orbit (one per tool call) | WORKING · tool name | Tool timeline expands |
| Awaiting approval | Dimmed, held still | **Halo**, solid, with a notch at 12 o'clock | Paused | NEEDS YOU | Approval card slides up; haptic tick |
| Speaking | Pulses with the TTS amplitude | Ivory, fine wave deformation | Normal | SPEAKING | Captions; tap the core to interrupt |
| Success | One soft flash (300 ms), then idle | Ivory | Settle | DONE | Result link + audit id |
| Error | Desaturated, slow | Thin `bad` arc segment, **no flashing** | Slowed | ERROR | Plain-language reason + Retry / Switch provider |
| Offline | Grey, static | Dashed | None | OFFLINE | "You're offline. Messages will wait; actions won't run." |
| Mic denied | Unchanged | — | — | — | Inline explanation + "Open settings"; the text composer stays primary |

### Voice honesty rules

The MVP labels voice as **turn-based** (push-to-talk → transcript → response → optional TTS). It never says "real-time" unless a streaming duplex transport is implemented and verified. Hands-free mode is only offered where platform permissions and foreground-service rules allow it.

## 7. Prototype

The interactive prototype at `prototype/index.html` (deployed as a preview) renders the ✦ screens from 02 §2 with **sample data labelled "Sample workspace"**. It includes the full Live AI state and agent switcher with a procedural canvas core, plus a dark/light theme toggle and a reduced-motion toggle. It is a design artifact, not the app. No buttons call real services.
