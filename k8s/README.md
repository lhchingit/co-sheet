# Kubernetes manifests

Deployment-time configuration that the application cannot express in its own code.

This is **not** a full deployment. There is no Deployment, Service, Ingress or Gateway
here — those belong wherever your cluster's manifests live. What is here is the routing
policy the application's correctness depends on, kept next to the code that explains
why it is needed.

| File | What it does |
|------|--------------|
| `destinationrule-file-affinity.yaml` | Istio `DestinationRule` hashing on `?file=` so all traffic for one workbook reaches one replica ([#273](https://github.com/lhchingit/co-sheet/issues/273)). |

## Running more than one replica: what must be true first

Both of these are correctness, not tuning. The application cannot enforce either from
inside itself, which is the only reason they are a checklist instead of code.

- [ ] **The `DestinationRule` is applied**, so each workbook has one writer. See
  [Applying it](#applying-it). Without it, two replicas holding one file overwrite
  each other's edits and nothing records that it happened.
- [ ] **`workbook_write_conflicts_total` is alerting**, not merely graphed. See
  [What it still does not cover](#what-it-still-does-not-cover). It is the only signal
  that the above has failed, or that a rolling update's ring reshuffle has cost
  someone an edit. It reads zero on a single replica, so any increase is real.

If you are running one replica, neither applies and nothing here is needed.

## Why routing is a correctness concern here, not a performance one

A workbook write rewrites the **whole document** from the replica's in-memory cache,
and the realtime bus that carries other replicas' edits is Redis pub/sub — no ordering
between publishers, no delivery guarantee. Two replicas holding the same file can
therefore overwrite each other's edits, with nothing recording that it happened.

This is not a scale problem. It needs **two people editing on two pods**, not a
thousand: shrinking a deployment does not shrink it. Hashing by file gives each
workbook one writer and one broadcaster, which closes it without an operation log or a
CRDT.

## Applying it

```bash
# 1. Fill in the namespace (two places in the file).
# 2. Check the host resolves and the fields are accepted by your Istio version.
istioctl analyze -n <namespace> k8s/destinationrule-file-affinity.yaml

# 3. Apply.
kubectl apply -f k8s/destinationrule-file-affinity.yaml
```

A `DestinationRule` is evaluated by the **client** proxy, which for ingress traffic is
the ingress gateway. It has to be visible there — apply it in the gateway's namespace,
or use `exportTo` (see the commented field in the manifest).

## What it still does not cover

Routing narrows the window; it does not remove it.

- **Scale events and rolling updates reshuffle the hash ring.** Roughly 1/N of
  workbooks change owner, and during that window two replicas can write one file. The
  compare-and-set on `workbook_state.version` ([#271](https://github.com/lhchingit/co-sheet/issues/271))
  is what covers that, and stays necessary after this lands.
  **Alert on `workbook_write_conflicts_total`** — it is zero on a single instance, so
  any increase means a replica overwrote a replica. See `METRICS_PORT` in the root
  README.
- **`default` is one hash key**, so the legacy shared workbook is a single hot replica
  by construction. Inherent to hashing by file.
- **One workbook is still bounded by one core.** The measured knee is ~300 concurrent
  cursor-only editors on a single shared document — see `loadtest/README.md`. Past
  that, routing is not the binding constraint; the O(N²) broadcast fan-out is.
