# The netplay worker (CHALLENGE A FRIEND)

This little program runs on Cloudflare. It does two jobs for online matches:

1. It **introduces the two players.** The host gets a room code like `HQ7ZK4`. The friend types it (or opens the link),
   and the worker passes a few connection messages between the two browsers. After that, the browsers talk to each
   other directly. The match itself never goes through the worker.
2. It **hands out relay passes (TURN).** Some home networks can't connect directly. Then the browsers send their traffic
   through Cloudflare's relay instead. The worker asks Cloudflare for a pass that expires after 3 hours, and only
   players who are in a room can get one.

It keeps nothing. A room deletes itself:
- 15 minutes after it was made, if no friend ever joined;
- 2 minutes after both players have left;
- 3 hours after it was made, at the latest.

You do this once. After that, run step 4 again only when this folder changes.

## What you need

- Your Cloudflare account (the free plan is enough).
- Node.js. You already have it for the game.
- A terminal (PowerShell) open in the game's folder.

## Step 1: make a TURN key in the Cloudflare dashboard

1. Log in at https://dash.cloudflare.com.
2. Open **Realtime** in the left menu (it used to be called **Calls**), then **TURN Server**.
3. Create a TURN key. Give it any name, for example `adeuk`.
4. Cloudflare shows two values: a **Turn Token ID** and an **API Token**. Keep the page open; you need them in step 3.
   Don't paste them anywhere else: not into chat, not into a file in this folder.

If the menu names differ, look for "TURN" in the dashboard's search box.

## Step 2: log in from the terminal

```text
cd netplay-worker
npx wrangler login
```

The first time, `npx` asks to download wrangler (Cloudflare's tool). Type `y`. A browser window opens: click **Allow**.

## Step 3: give the worker its two secrets

Still in the `netplay-worker` folder:

```text
npx wrangler secret put TURN_KEY_ID
```

When it asks, paste the **Turn Token ID** and press Enter. Then:

```text
npx wrangler secret put TURN_KEY_API_TOKEN
```

Paste the **API Token** and press Enter.

Secrets live only on Cloudflare. You can't see them again, but you can set them again the same way. If the worker
doesn't exist yet, wrangler offers to create it: say yes.

## Step 4: deploy

```text
npx wrangler deploy
```

The first time, wrangler may ask you to pick a `workers.dev` subdomain (any name you like). When it finishes, it prints
the worker's address, for example:

```text
https://adeuk-netplay.yourname.workers.dev
```

Check it: open that address in a browser. It should say `ok`.

## Step 5: tell the game where the worker is

Open `src/net/config.ts` in the game and put the address between the quotes:

```ts
export const NETPLAY_URL = 'https://adeuk-netplay.yourname.workers.dev';
```

No slash at the end. Commit and push as usual. After the next deploy of the site, **ONLINE / 온라인** on the title
screen works.

To try a worker without changing the code, add it to the game's address:
`…/play/?net=https://adeuk-netplay.yourname.workers.dev`.

## Which sites may use it

`wrangler.toml` lists them under `ALLOWED_ORIGINS`:
- `https://adeuk-titans.vercel.app`;
- `https://rustassured.github.io`;
- `localhost` (always allowed, for testing).

If the game moves to another address, add it there (comma-separated) and run `npx wrangler deploy` again.

## If something goes wrong

| What you see | What to do |
|---|---|
| ONLINE says "NOT SET UP YET" | Step 5 isn't done, or the site hasn't been redeployed since. |
| "COULD NOT REACH THE SERVER" | Open the worker address in a browser: it must say `ok`. If not, run step 4 again. |
| Players on some networks can't connect | Check the two secrets (step 3). Without them there's no relay, and some networks need it. |
| "TOO MANY TRIES" | One address made more than 10 rooms in a minute. Wait a minute. |

Live logs while you test: `npx wrangler tail`.

## For programmers

- Code: `src/index.ts`: the worker plus the `Room` Durable Object (SQLite-backed, as the free plan requires).
- It type-checks with no packages installed: `npx tsc -p netplay-worker`, using the small stubs in `src/env.d.ts`.
  Nicer: `npm i -D @cloudflare/workers-types` at the repo root (or `npx wrangler types`), set
  `"types": ["@cloudflare/workers-types"]` in `tsconfig.json`, and delete `src/env.d.ts`.
- Protocol and design: `docs/netplay/STEP1.md`.
