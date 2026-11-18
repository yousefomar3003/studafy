# Moving Studafy to its own fly.io organisation (QA-072)

**Who:** the fly.io account owner. **Needs:** `flyctl` signed in as that owner, admin on the
`prod` GitHub Environment, and a quiet window of about 30 minutes (each app restarts once).

## Why

Every Studafy app runs in the owner's `personal` fly organisation. A fly organisation is one private
network (6PN): **any** app in it can open a connection to any other app's private address. Today
that includes whatever else lives in `personal`. From such an app, someone could:

- reach clamd on `studafy-core-scanner.flycast:3310`. clamd has no authentication, so they could
  send it `SHUTDOWN` and stall every upload scan, or use it to scan their own data;
- scrape the services' Prometheus endpoints (port 9464);
- call the API's machines directly over 6PN, around fly's edge, with a `Fly-Client-IP` header of
  their own choosing. The API side of that is QA-086.

Nothing in the repository can fix this: clamd has no way to turn off `SHUTDOWN`, and the flycast
proxy needs clamd listening on the private network. The fix is a dedicated organisation that holds
only Studafy's apps.

What the repository already does: the metrics endpoints listen on the 6PN address only
(`METRICS_HOST = "fly-local-6pn"` in api.toml, realtime.toml and workers.toml), not on every
interface, and the scanner has a private (flycast) address only.

## Before you start

1. List what is in `personal`, so you know which apps are not Studafy's and stay behind:

   ```sh
   fly apps list --org personal
   ```

2. Pick the new organisation's slug. This runbook uses `studafy`; substitute yours everywhere.

## Steps

1. **Create the organisation** (it needs a payment method, like `personal` has):

   ```sh
   fly orgs create studafy
   ```

2. **Move the apps.** Each move restarts the app's machines. Move the scanner and workers before the
   API, so uploads are never scanned by an unreachable clamd for longer than one restart:

   ```sh
   for app in studafy-core-scanner studafy-core-workers studafy-core-realtime \
              studafy-core-migrate studafy-core-api studafy-core-web studafy-log-shipper; do
     fly apps move "$app" --org studafy --yes
   done
   ```

3. **Give the scanner its private address again.** Flycast addresses belong to an organisation's
   network, so check it and allocate a new one if the move dropped it:

   ```sh
   fly ips list --app studafy-core-scanner        # expect one "private" v6 row, and no public row
   fly ips allocate-v6 --private --app studafy-core-scanner   # only if that row is missing
   ```

4. **Point the log shipper at the new organisation.** In `infra/fly/log-shipper.toml`, change
   `ORG = "personal"` to `ORG = "studafy"` (and the `ACCESS_TOKEN` comment), commit it through a
   normal PR, then:

   ```sh
   fly secrets set --app studafy-log-shipper ACCESS_TOKEN="$(fly tokens create readonly studafy)"
   fly deploy --config infra/fly/log-shipper.toml
   ```

5. **Replace the deploy token.** `FLY_API_TOKEN` in the `prod` GitHub Environment is a set of
   app-scoped deploy tokens. Create new ones after the move and replace the secret with them, joined
   with commas after one `FlyV1 ` prefix (infra/fly/README.md, "First-time setup", step 3):

   ```sh
   for app in studafy-core-api studafy-core-realtime studafy-core-workers \
              studafy-core-scanner studafy-core-web studafy-core-migrate; do
     fly tokens create deploy --app "$app" --expiry 8760h
   done
   ```

   Then revoke the old tokens (`fly tokens list`, `fly tokens revoke <id>`).

6. **Redeploy once from `dev`** with the **Production deploy (fly.io)** workflow, so every service
   comes up with the new token and the moved network.

## Check it worked

Record the output of each of these in `docs/qa/evidence/QA-072-fly-org.md`:

1. Every Studafy app is in the new organisation, and nothing else is:

   ```sh
   fly apps list --org studafy
   fly apps list --org personal     # no studafy-* app left
   ```

2. The scanner and workers have no public address; the API and web have only their edge
   addresses:

   ```sh
   for app in studafy-core-scanner studafy-core-workers studafy-core-realtime \
              studafy-core-api studafy-core-web; do fly ips list --app "$app"; done
   ```

3. clamd is unreachable from the old organisation. From any app that stays in `personal`:

   ```sh
   fly ssh console --app <an app in personal> \
     -C "sh -c 'echo PING | nc -w 5 studafy-core-scanner.flycast 3310 || echo unreachable'"
   ```

   Expect `unreachable` (the name no longer resolves there). If no app is left in `personal`, make a
   throwaway one there, run the same check from it, then delete it:

   ```sh
   fly apps create qa072-probe --org personal
   fly machine run alpine:3.20 --app qa072-probe -- sleep 600
   fly ssh console --app qa072-probe -C "sh -c 'echo PING | nc -w 5 studafy-core-scanner.flycast 3310 || echo unreachable'"
   fly apps destroy qa072-probe --yes
   ```

4. clamd is still reachable from the workers, and scanning works. Upload a material in the app
   and check that it ends `clean`, or run:

   ```sh
   fly ssh console --app studafy-core-workers \
     -C "bun -e \"const s=await Bun.connect({hostname:'studafy-core-scanner.flycast',port:3310,socket:{data(_,d){console.log(String(d));process.exit(0)}}});s.write('zPING\0')\""
   ```

   Expect `PONG` (the first connection may take about 30 s while the scanner starts).

5. Metrics still arrive: the fly.io metrics dashboard (Grafana) still shows
   `http_server_request_duration_seconds` for api, and the BullMQ series for workers.

6. Logs still arrive in Axiom's `studafy-logs` dataset.

## Rolling back

`fly apps move <app> --org personal --yes` moves an app back. Repeat steps 3 to 6 against `personal`.
