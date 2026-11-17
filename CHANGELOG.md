# Changelog

## [0.1.0] - 2026-11-17

First release.

- Map project folders to login profiles in `~/.pi/agent/agent-hopper.json`. The longest matching folder wins.
- The first run writes `~/.pi/agent/agent-hopper.example.json` to copy from, and `/hop` shows the `cp` command until a config exists.
- `"block"` folders refuse every prompt, so an unmapped client folder never falls back to a personal login.
- `piLogin` names Pi's own `/login` as a profile, so personal work needs no second sign-in. Signing it into or out of a provider from `/hop` fills in Pi's `/login` or `/logout`.
- `/hop` shows the current profile and its logins, switches profile for the session, signs profiles in and out, and changes their colors.
- Profiles hold subscription sign-ins (ChatGPT, Claude Pro/Max, …), API keys, and Amazon Bedrock bearer tokens or AWS profiles.
- New keys are checked before they're saved, and keys and tokens are typed into a masked prompt.
- The status line shows a color-coded profile badge, the model and subscription in the agent's color, and a red warning when a login is missing.
