# kesher Companion module

Custom Bitfocus Companion module for controlling `kesher` browser sessions.

## What it does

- Connects to backend bridge WebSocket (preferred): `/api/companion/ws?roleId=<roleId>`
- Loads discovery data (preferred): `/api/companion/discovery?roleId=<roleId>`
- Preferred binding target: `roleId` (`/api/companion/ws?roleId=<roleId>` and `/api/companion/discovery?roleId=<roleId>`)
- Legacy migration fallback: `username` query parameter is still accepted
- Supports per-role page targeting via Kesher profile metadata (`pageNumber`), with optional module override
- Loads admin-managed role Stream Deck layouts from Kesher profile data and exposes them as 15 universal live Companion slots
- Does not automatically write/overwrite Companion button pages; Companion modules can expose presets, but Companion page/bank placement still needs to be done once in Companion
- Direct user target choices are sourced from active sessions (`activeRoleUsers`) when available
- Exposes actions for:
  - voice mode (`always_on` / `ptt`)
  - voice mode toggle
  - listen/talk room matrix selection
  - PTT to matrix anchor room (`talk[0]` or fallback `listen[0]`)
  - direct PTT to explicit partyline target
  - PTT to explicit target (`room` / `direct` / `broadcast`)
  - direct PTT to active user by role ID
  - reply to latest direct caller (PTT)
  - scoped signal sending
  - lookup active user by arbitrary role ID
  - lookup partyline by arbitrary partyline ID
  - query state value by path (generic dynamic access)
- Exposes feedbacks for:
  - bridge connected/bound
  - mic live
  - voice mode
  - listen/talk selected rooms
  - last command failed
  - dynamic button image with per-button display mode:
    - global int->effect mapping comes from backend `imageEffectMapJson`
    - per-slot int values come only from image stream `effectValue`
    - resolved modes:
      - `0` = backend image only
      - `1` = one-color blinking overlay
      - `2` = one-color solid glow overlay
- Exposes only universal synced slot variables:
  - `btn_1_label` ... `btn_100_label`
  - `btn_1_bgcolor` ... `btn_100_bgcolor`
  - `btn_1_textcolor` ... `btn_100_textcolor`
  - `btn_1_effect` ... `btn_100_effect`
  - colors are Companion numeric RGB values (same format as `combineRgb(...)`)

## Develop/build

```sh
npm install
npm run build
```

If you use Yarn 4:

```sh
yarn
yarn build
```

## Package for Companion local install

```sh
npm run package
```

This uses `companion-module-build` and produces a package artifact in this module directory.

## Install in Bitfocus Companion (local module)

1. Build/package this module.
2. In Companion, add a local custom module (or import local module package artifact).
3. Configure:
   - backend host/port
   - TLS on/off
   - target role ID (preferred)
   - optional target username for legacy fallback during migration
   - optional `Target page override`:
     - `-1` = use role→page mapping delivered by Kesher backend
     - `>= 0` = force this Companion page number for this module instance
4. In Kesher Admin, configure the role Stream Deck layout and publish the Companion profile for that role.
5. In Companion, open the Kesher connection presets and drag the 15 presets from `Universal Synced Layout` onto the desired page once.

## Notes

- The module controls an existing browser session; it does not capture microphone audio itself.
- Commands are acknowledged with command IDs and surfaced through failure/command feedbacks.
- Page isolation tip: keep Kesher controls on a dedicated page per role/module instance; keep other workflows on separate pages.
- Once a universal synced slot is placed on a Companion button, later Kesher profile publishes update its label, color and runtime behavior without rebuilding the package or re-dragging the preset.
- The module forwards only generic slot presses to Kesher. Kesher resolves the action server-side, including page changes and input-gain deltas, so Companion stays a thin client.
- In `Display Dynamic Web-UI Button Image` feedback, effect mode/color always come from backend values and global mapping.

## Backend-driven image effect mapping

The module can consume a global JSON map and per-slot integer values from Companion bridge state.

Accepted companion state field for the global JSON map:

- `imageEffectMapJson`

Accepted image stream fields (per image update) for per-slot integer value:

- `effectValue`

### Example JSON map

```json
{
  "0": { "mode": 0 },
  "1": { "mode": "blink", "color": "#ff2d26" },
  "2": { "mode": "static", "color": "#26d07c" }
}
```

Rules:

- map key = integer effect value from backend per slot
- `mode` supports `0|1|2` and aliases `none|blink|static`
- `color` (or `colorHex`) uses hex color like `#RRGGBB`; fallback is `#ff2d26`

### Minimal backend payload examples

Companion bridge state message:

```json
{
  "type": "companion_state",
  "data": {
    "username": "regie",
    "bound": true,
    "imageEffectMapJson": "{\"0\":{\"mode\":0},\"1\":{\"mode\":\"blink\",\"color\":\"#ff2d26\"},\"2\":{\"mode\":\"static\",\"color\":\"#26d07c\"}}"
  }
}
```

Image stream update message:

```json
{
  "type": "update_button_image",
  "bank": 0,
  "buttonIndex": 7,
  "imageBuffer": "<base64-png>",
  "effectValue": 1
}
```

In this example, `effectValue: 1` resolves to blink red via the map above.
- Dynamic query path examples:
  - `roles.regie.username`
  - `roles.regie.active`
  - `roles.regie.userId`
  - `partylines.line_a.name`
  - `partylines.line_a.canTalk`
