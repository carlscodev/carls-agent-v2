---
name: kubernetes
description: Deploy and debug workloads on Kubernetes: manifests, probes, resources, rollout and troubleshooting.
version: 1
when_to_use: Use for manifests, Helm charts, deployment failures, or cluster debugging.
tags: [kubernetes k8s kubectl helm deployment pod service ingress probe resources]
---
# Kubernetes

## Manifests

- Declarative YAML in version control. `kubectl apply`, never imperative edits to
  a live cluster.
- Set `requests` and `limits` on every container. Without requests the scheduler
  guesses; without limits one pod can take the node down.
- Labels and selectors are the API of a deployment. Keep them consistent and
  specific (`app.kubernetes.io/name`).
- `namespace` explicitly in every manifest, or via `-n`.

## Health

- `readinessProbe`: is this pod ready for traffic? Fails fast, removes from
  service endpoints.
- `livenessProbe`: is this process wedged? Restart it. Keep it conservative; an
  aggressive liveness probe causes restart loops.
- `startupProbe` for slow-booting apps so liveness does not kill them early.
- Probes must be cheap. A probe that hits the database causes cascading failure.

## Rollout

- `RollingUpdate` with `maxSurge`/`maxUnavailable` that keeps capacity.
- `PodDisruptionBudget` so voluntary disruptions cannot take everything down.
- `terminationGracePeriodSeconds` longer than your slowest in-flight request, and
  handle SIGTERM.
- Know how to roll back: `kubectl rollout undo deployment/<name>`.

## Debugging order

1. `kubectl get pods -o wide` — status and node.
2. `kubectl describe pod <p>` — events at the bottom tell you why.
3. `kubectl logs <p> --previous` — the crash before the restart.
4. `kubectl exec -it <p> -- sh` — is the app actually listening?
5. Check the service selector matches the pod labels; a mismatch is the most
   common "it works but is unreachable".

Common statuses: `ImagePullBackOff` (bad image or missing pull secret),
`CrashLoopBackOff` (app exits; read previous logs), `Pending` (no node fits the
requests), `OOMKilled` (raise memory or fix the leak).

## Safety

- Never `kubectl delete` a namespace or PVC in production without a backup.
- Use `--dry-run=server` to validate before applying.
- Secrets are base64, not encrypted. Use a real secret store.
