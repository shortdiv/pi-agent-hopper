# pi-agent-hopper

![Pi's status line in five folders: a personal profile, three client profiles, and a blocked folder](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/preview.png)

Keep work and personal AI logins apart in [Pi](https://pi.dev). Each project folder maps to a **profile** so you never have to worry about mixing subscriptions. `/hop` switches profiles by hand, overriding the default settings.

## Setup

```sh
pi install npm:@shortdiv/pi-agent-hopper
```

The first time Pi runs with agent-hopper, it writes an example config, which Pi doesn't load. Copy it to make your own:

```sh
cp ~/.pi/agent/agent-hopper.example.json ~/.pi/agent/agent-hopper.json
```

Then edit the folders. It looks like this:

```json
{
  "piLogin": "personal",
  "folders": {
    "~": "personal",
    "~/clients": "block",
    "~/clients/acme": "acme",
    "~/clients/globex": "globex"
  },
  "colors": { "globex": "#ffc53d", "personal": ["#00c2ff", "#7b61ff", "#ff5ea8"] }
}
```

Then start Pi in each client folder and run `/hop` → **Sign "<profile>" into a provider** once for each subscription or API key that profile needs.

## How to use

### `/hop`

![The /hop menu for the personal profile: its logins, then Switch profile, sign into or out of a provider, and Change color](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/hop.png)

- **Switch profile** changes the profile for this session only. You can choose a saved profile, Pi's own login, or a new profile. Resuming or `/reload`ing keeps the choice, and forks and `/new` start from the folder mapping again.

  ![The Switch profile picker: acme, globex, personal (Pi's /login) and New profile](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/switch-profile.png)

- **Back to folder mapping** appears after a switch, when the badge shows `(switched)`. It undoes the switch.

  ![/hop after switching to the personal profile for this session, with Back to folder mapping selected](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/hop-switched.png)

- **Sign into a provider / Sign out of a provider** adds or removes one login for the profile: a subscription or an API key, or for Bedrock a bearer token or an AWS profile. Keys are typed into a masked prompt and checked with the provider before they're saved. For your `piLogin` profile, `/hop` fills in Pi's `/login` or `/logout` for you.

  ![The /hop menu with Sign "personal" into a provider selected](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/signin.png)

- **Change "[profile]" color** picks the badge color, with a live preview of each option. You can also enter your own hex value, or several for a gradient.

  ![The color picker: Automatic, then Amber, Gold, Lime, Green, Teal, Purple, Pink, Brown and Slate, each with a preview badge](https://cdn.jsdelivr.net/npm/@shortdiv/pi-agent-hopper/images/color.png)

## Security

- **Storage:** credentials are stored in `~/.pi/agent/agent-hopper/profiles/<name>.json` as **plaintext JSON**, readable only by you (`0600`). This is no different from Pi's own `auth.json`, which doesn't encrypt config
- **Network:** saving a key sends a check request to make sure keys are valid as long as the provider has a free `GET` health end point 
- **Limits:**
  - Pi's bash tool and other subprocesses still inherit your shell's keys, so start client sessions from a clean shell, with [direnv](https://direnv.net) for instance
  - Tools the agent runs (`gh`, `aws`, …) use their own logins (this won't work for those)

Found a problem? [Open an issue](https://github.com/shortdiv/pi-agent-hopper/issues), or [report it privately](https://github.com/shortdiv/pi-agent-hopper/security/advisories/new)

## How it works

Pi resolves every request's credentials through the provider's auth handlers. 

Credentials use Pi's `auth.json` format, one file per profile (see [Security](#security)). Token refreshes run under a cross-process lock, so concurrent sessions on the same profile never use up each other's refresh token.

To remove a profile, sign it out of each provider with `/hop`, or delete its file.

> Be mindful that Anthropic bills Claude Pro/Max use through third-party tools like Pi as extra per-token usage

## FAQ

<details>
<summary>How do folders map to profiles?</summary>

In `agent-hopper.json`, and the longest matching folder wins. Sign a profile in with `/hop` → **Sign into a provider**, or create one with `/hop` → **Switch profile** → **New profile**.

</details>
<details>
<summary>How is this different from <code>/login</code>?</summary>

`/login` signs in Pi's own login, and `/hop` signs in a profile. `piLogin` names Pi's login (here `personal`), so personal work needs no second sign-in. Client profiles never use it.

</details>
<details>
<summary>How do I stop an unmapped folder from using my personal login?</summary>

Map the parent folder to `"block"`. Unmapped client folders then block prompts until you pick a profile with `/hop`.

</details>
<details>
<summary>What if a profile isn't signed in to the model I'm using?</summary>

The prompt is blocked. There's no fallback to another login or to keys in your shell.

</details>
<details>
<summary>Can I run client and personal sessions at once?</summary>

Yes. Each Pi session uses its own folder's profile.

</details>
<details>
<summary>How do I change colors?</summary>

For client badges, use `/hop` → **Change color**, or `colors` in the config. For the model and subscription text, use `agentColors`. Values are a hex color, a list of hex colors for a gradient, or `"none"`.

</details>

## License

MIT
