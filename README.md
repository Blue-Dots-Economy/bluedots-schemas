# bluedots-schemas

Canonical, deploy-time configuration for every Blue Dots network ("dot") and brand.

Nothing here is committed into a container image. `scripts/fetch-configs.sh` in
**bluedots-automation** pulls these files fresh on every deploy and the Helm charts
render them into ConfigMaps, so changing a file + redeploying is enough — no image
rebuild.

## Layout

One directory per network, one optional sub-directory per brand:

```
<network>/
  network.json                     # signals + aggregator network schema
  consent.json                     # SIGNALS consent      {"documents": …}
  messages.properties              # email copy
  aggregator.config.yaml           # network binding, brand strings, domain labels
  brand.json                       # design tokens (image-baked today — see below)
  schemas/aggregator/consent.json  # AGGREGATOR consent   {"audiences": …}

  <brand>/                         # any SUBSET of the above
    …
```

Directory names use underscores for networks (`blue_dot`, `orange_dot`) and hyphens
for brands (`up-gzb`, `ka-dhwd`). A brand directory is not required to be complete.

## The fallback rule

**A brand file is used when it exists; otherwise the network-level file is used.**
That is the whole contract, and it is why a brand directory only needs the files it
actually overrides.

How the fallback is applied differs per artifact, because the consuming app differs.
This distinction is load-bearing — read it before adding a brand file.

| File | Resolution | Meaning |
|---|---|---|
| `network.json` | **override** | Brand file wins **whole-document**. A network schema is never a partial. |
| `aggregator.config.yaml` | **override** | Same — a full document. |
| `schemas/aggregator/consent.json` | **override** | Same — the aggregator loader does not merge. |
| `consent.json` | **layered** | Brand file may be a **partial**; the signals api merges **per key** over the network file. |
| `messages.properties` | **layered** | Same — merged **per key** (bundled defaults < network < brand). |

### "layered" means the brand file may be incomplete — on purpose

`blue_dot/upsdm/consent.json` and `orange_dot/onetac/consent.json` define only
`documents.privacy` and `documents.terms`. Everything else — `profile_creation`,
the `u18_documents` set and every action consent — comes from the network file. The
signals loader resolves per key (`brand[key] ?? network[key]`), so both files ship
and are merged.

**Do not "complete" a partial brand consent by copying the network file into it.**
It would work, but the two copies then drift silently, and a network-level consent
change would stop reaching that brand.

Conversely, **do not** convert an `override` artifact to a partial — nothing merges
those, so a partial `network.json` simply loses whatever it omits.

### Two different documents are both called `consent.json`

This trips everyone up once:

- `<network>/consent.json` — **signals**, shape `{"documents": …}`
- `<network>/schemas/aggregator/consent.json` — **aggregator**, shape `{"audiences": {org, aggregator}}`

Same filename, different schema, different consumer. The `schemas/aggregator/`
sub-path is what keeps them apart; the fetch script asserts the shape and fails the
deploy if they are swapped.

### No symlinks

Configuration is fetched over `raw.githubusercontent.com`, which does **not**
traverse a symlinked directory — a path through one 404s. Every file here must be a
real file, even where that means two identical copies (`blue_dot/` and `purple_dot/`
both carry the generic aggregator consent). If you are tempted to symlink, add the
file instead.

## What resolves from where, today

| Target | `network.json` | `consent.json` | `messages` | `aggregator.config` | agg. `consent` |
|---|---|---|---|---|---|
| `blue_dot` | network | network | network | network | network |
| `blue_dot/ka-dhwd` | brand | brand | network | network | brand |
| `blue_dot/up-gzb` | brand | brand | network | brand | brand |
| `blue_dot/upsdm` | network | brand | brand | brand | network |
| `orange_dot` | network | network | network | network | network |
| `orange_dot/onetac` | network | brand | brand | brand | brand |
| `purple_dot` | network | network | network | network | network |
| `yellow_dot` | network | network | network | — | — |

`yellow_dot` has no aggregator deployment, so it carries neither aggregator
artifact. Add both if one is ever stood up.

## Adding a network

Create `<network>/` with, at minimum, `network.json` and `consent.json` — those are
the two the deploy hard-fails without. `messages.properties` is optional (the api
ships complete bundled email copy and merges per key). Add the two aggregator files
only if that network gets an aggregator deployment.

## Adding a brand

Create `<network>/<brand>/` containing **only the files that differ**. Anything you
leave out falls back to the network level, which is the point — an empty brand
directory is a valid "same as the network" brand.

## Other files at the repo root

`apps/ui/public/reference/colleges-{ka,up}.json` are the signals UI
reference-autocomplete datasets, selected per environment. The remaining loose
root-level `*.json` files (`blue_dots_network.json`, `generalized-*-schema.json`,
`orange-dots-schemas.json`, `purple-dot-seeker-schema.json`,
`yellowdots-cl-educate-schemas.json`, `yellow_dot_network.json`) are **not read by
any deploy** — they predate the per-network layout and are kept for reference.

## Pinning

The deploy fetches from a ref you choose (`SCHEMAS_REF`, default `main`). Pin a tag
or commit SHA for production so a merge here cannot change a running environment
between deploys; the fetch script warns when it is given a moving branch.
