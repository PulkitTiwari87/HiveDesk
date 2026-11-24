# Hivedesk trailer: master prompt for `/brag`

**How to use**

1. Open Claude Code **in the Hivedesk project folder** (`D:\Claude Code\Munder Defflin`), so `/brag` can read the code.
2. Make sure the `brag` plugin and the Hyperframes skills are installed (they are on this machine).
3. Paste everything inside the box below as one message.
4. Result: `brag-output-<timestamp>/brag.mp4`, `brag.jpg` (poster), `brag-plan.md`, `share-copy.txt`.

Optional: add `--voice` to the first line for a deadpan trailer-announcer voiceover (Kokoro). Add `--no-music` or `--no-sfx` to turn those off.

---

## The prompt (copy from here)

```
/brag --tone cinematic --format landscape --duration 25 --title "Hivedesk"

Make a launch TRAILER for Hivedesk, the project in this folder. Creative direction: "a tiny pixel-art workplace
comedy, cut like a blockbuster trailer for the future of coding." Deadpan epic. Trailer-scale confidence about
something delightfully small. 25 seconds. Use a timestamped output folder so earlier runs are never overwritten.

== SOURCE OF TRUTH ==
Read the code, not a website (nothing is hosted). Priority: README.md, SPEC.md, package.json,
src/renderer/index.html, src/renderer/styles.css (design tokens), src/renderer/office.js (the pixel office),
src/renderer/app.js (tabs, control bar, Claude Code mirror), src/main/presets.js (the Designer agent),
docs/screenshots/office.png and app.png, build/icon.png. Use the project's own words and claims. No generic SaaS language.

== WHAT HIVEDESK IS (pre-answered rubric; confirm against the code and correct me if the code disagrees) ==
1. What is it: "A tiny pixel office where your AI coding agents actually work." A Windows desktop app (Electron) that runs
   real Claude Code / Codex / Gemini / Copilot CLIs in real terminals, shows each agent as a small character in a pixel office,
   and lets them message each other through a shared on-disk hive while an orchestrator delegates.
2. Most impressive/funny claim: agents walk over to YOUR desk with a pulsing "!" to ask permission, and "Hivedesk never
   answers a prompt for you." Runner-up: agents idle at the water cooler and the couch.
3. Visual hook: the warm cream pixel office with characters at desks, the yellow accent, the permission card.
4. Show from the actual UI: the office floor (status-driven characters, tool bubbles like Edit / Bash, a paper letter flying
   desk to desk), the permission card, the terminal, the Claude Code tab, the model/effort pill bar.
5. Shortest satisfying video: 25 seconds, no padding.
6. Tone: preset cinematic. Creative direction as above. Humor comes from the contrast: epic trailer grammar, tiny pixel clerks.
7. Audio: low cinematic bed with one swell on the reveal, restrained motion-matched SFX (typewriter ticks, office door chime,
   paper whoosh, UI click, soft permission "ding"). One dry hit on the final title. No voice unless --voice was passed.
8. Share caption: "I gave my AI coding agents an office. They sit at desks, walk to the water cooler, and come ask me
   before running anything risky. Hivedesk: free, MIT, Windows."
9. User flow worth showing (entry, key action, result): hire an agent (or one-click "+ Designer") -> watch the team work in the
   office -> an agent walks over, the permission card appears, you click Allow -> then the Claude Code tab mirrors your chats
   and the model/effort bar switches Opus -> High in one click.

== STORYBOARD (scene durations must sum to 25.0s; refine the wording, keep the beats) ==
S1  0.0-3.0   HOOK. Black. Monospace line types out: "In a world where AI agents code alone..." Hold until fully read.
              Low hit, hard cut.
S2  3.0-7.5   REVEAL. The warm cream pixel office fades up with a slow push-in; characters at desks, the door opens and a
              new character walks in. Title card "HIVEDESK" (system font, tight tracking) with the line "A tiny pixel office
              where your AI coding agents actually work." Music swell lands on the title.
S3  7.5-12.0  "They're real." Cut between a desk (character typing, bubble "Edit", then "Bash") and the dark terminal pane
              showing a real CLI running. A paper letter flies from Orion to Ada. Caption: "Real terminals. Not a simulation."
S4  12.0-17.0 "They ask." A character walks to YOUR desk, pulsing "!". The permission card slides in:
              "Ben needs you / Claude needs your permission to use Bash / [Allow] [Deny] [Open terminal]".
              A cursor clicks Allow (press scale 0.97, soft ding). Caption: "They never answer for you." Centerpiece scene.
S5  17.0-21.0 "Your Claude Code, too." The Claude Code tab: a live chat list with a green "working" dot and a chat that
              mirrors your session. Then the model/effort bar: the cursor clicks Opus, then High (pills light up yellow).
              Caption: "Switch model and effort in one click."
S6  21.0-25.0 PUNCHLINE + OUTRO. Pull back to the full office. A new hire character "Designer" walks in and sits down.
              Final card: HIVEDESK, "Hire your team.", "Windows - MIT - github.com/PulkitTiwari87/HiveDesk".
              Dry hit, hold the end card at least 1.5s, then fade.

== VISUAL IDENTITY (exact values from src/renderer/styles.css and office.js) ==
Canvas #fbf5e6, cards #ffffff, raised #f1ece0, ink #1d1d1f, muted #6b6b73, accent yellow #f6c445 (ink on yellow #1d1d1f).
Status colors: working #2fa84f, idle #3b82f6, needs-you #f2a900, starting #a855f7, error/exited #e5484d.
Terminal pane #1d1d1f with #f5f5f7 text. Pixel art outline #3a2f26. Fonts: system UI sans for display and body
(Segoe UI / San Francisco style), Cascadia Mono for terminal and code. Look: light, warm, Apple-clean: layered soft shadows,
pill controls, 16px card radius. Use docs/screenshots/office.png and app.png as real footage. For scenes the screenshots do
not cover (permission card, Claude Code tab, control bar), rebuild the UI faithfully in HTML/CSS from index.html, styles.css
and app.js, using the app's real copy. Pixel art stays crisp: image-rendering: pixelated, integer scales only, never blur it.
Motion: springs and critically damped eases, slow push-ins, no bounce on UI; each text holds long enough to read
(short label >= 0.8s, sentence ~0.3s per word). Fast cuts, never flashing text.

== HARD RULES (truth, privacy, IP) ==
- Only show features that exist today: the pixel office, real terminals, the shared hive (messages, memory, board, tasks, log),
  the orchestrator, permission card with Allow / Deny / Open terminal, autonomy levels, the read-only Claude Code mirror tab
  with "Delegate to agent", the model/effort bar, the Designer hire preset. Nothing else.
- Do NOT claim: Mac or Linux support (Windows only), that Hivedesk controls or types into your external Claude Code chats
  (the mirror is read-only), that agents act without permission, exactly-once or cloud features, benchmarks, user counts,
  testimonials, fake logos, or invented numbers.
- No personal data on screen: never show a real username, home path or email. Use the neutral path C:\Workspace\Hivedesk\hive.
- IP: Hivedesk is inspired by the MIT-licensed Munder Difflin harness (credit it only in a tiny end-card line if there is room:
  "Inspired by Munder Difflin"). Do not use The Office (TV) names, logos, music, quotes or character likenesses. The pixel art
  is original; keep it that way. Use only music and SFX that ship with the brag skill.
- Keep Hivedesk's character names: Orion (orchestrator), Ada, Ben, Cy, Dee, Eli, Designer.

== PROCESS ==
Follow the /brag steps exactly: inspect the code and answer the 9-question rubric, write brag-plan.md with this storyboard
(adjusting only if the code contradicts it), hand the composition brief to Hyperframes, run `npx hyperframes check` until zero
errors, render brag.mp4, pick the best poster frame (brag.jpg) and bake it as frame 0, write share-copy.txt (use the caption
above or something punchier in the same spirit). Print a short summary of the plan in chat as you go, but do not stop for
approval unless one of the hard rules conflicts with the code. When done, tell me the output folder, the final duration, and
anything you could not do.
```

---

## Follow-up prompts (use after the landscape cut is done)

**Vertical cut for X / TikTok / Reels**

```
/brag --tone cinematic --format vertical --duration 20 --title "Hivedesk"
Reuse the plan and composition from the latest brag-output folder. Re-frame for 9:16: bigger captions, the office cropped
to the busiest desk cluster, the permission card centered. Same hard rules. New timestamped output folder.
```

**Voiceover version**

```
/brag --voice --tone cinematic --format landscape --duration 25 --title "Hivedesk"
Same as the last run, plus a deadpan movie-trailer announcer. Short lines that do not read the on-screen text:
"In a world where AI agents code alone..." / "One office changes everything." / "They ask before they act." /
"Hivedesk. Hire your team."
```

**Recut shorter (15s teaser)**

```
/brag --tone cinematic --duration 15 --title "Hivedesk"
Teaser cut of the latest plan: S1 hook, S2 reveal, S4 permission card, S6 end card only. Same hard rules.
```
