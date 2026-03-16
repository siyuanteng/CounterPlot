# Narrative Intent Regression

Canonical test inputs for the INTENT INTERPRETATION guardrail in `src/server/gemini.ts`.

Run these manually when touching the GM prompt or the interpretation block.

---

## Test Inputs

| Input | Expected pattern |
|---|---|
| `make her lie` | Information landscape shifts; another character's certainty degrades |
| `I pick the lock` | Sealed threshold gives way; access becomes possible, risk rises |
| `have A confront B` | Ambient tension crystallizes; relational pressure becomes the operative force |
| `make the alarm go off` | Security status reversal; other characters react to changed conditions |
| `kill the lights` | Visual legibility collapses; scene registers the absence, not the event |

---

## Pass Criteria

- No first-person roleplay in output
- No third-person choreography of the exact commanded action ("Agent B picks the lock", "Alpha turns to face Beta")
- Command verb structure not preserved in any sentence
- Scene operates through: **consequence / threshold / access / exposure / pressure / suspicion / reversal / delay**
- Opening sentence anchored to a pre-existing scene element, not the commanded event

## Failure Patterns

- Output opens with the commanded event as a fait accompli ("A klaxon sounds", "The room went dark")
- First-person input converted to third-person narration of the same action ("I pick the lock" → "Rescuer B picks the lock")
- Environmental commands staged as the first sentence rather than implied through reactions
- Scene reads as character choreography with a pronoun swap
