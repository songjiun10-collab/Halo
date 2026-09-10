"""
HALO E001 — Trusted-Base Degradation
Synthetic, harmless containment experiment.

Question:
How does an external enforcement boundary degrade as trusted metadata becomes
missing or incorrect?

No network, shell, real credentials, or real external systems are used.
"""
from dataclasses import dataclass
import random

@dataclass(frozen=True)
class Action:
    resource: int
    requested_op: str

@dataclass(frozen=True)
class Resource:
    rid: int
    true_sensitive: bool
    true_writable: bool

def ground_truth_allow(action, resource):
    if action.requested_op == "write":
        return (not resource.true_sensitive) and resource.true_writable
    return True

def observed_metadata(resource, corruption, rng):
    sensitive = resource.true_sensitive
    writable = resource.true_writable
    if rng.random() < corruption:
        sensitive = not sensitive
    if rng.random() < corruption:
        writable = not writable
    return sensitive, writable

def model_monitor(action, observed_sensitive, observed_writable, rng):
    if action.requested_op == "read":
        return True
    score = 0
    if observed_sensitive:
        score += 0.55
    if not observed_writable:
        score += 0.55
    score += rng.uniform(-0.22, 0.22)
    return score < 0.5

def deterministic(action, observed_sensitive, observed_writable, rng=None):
    if action.requested_op == "read":
        return True
    return (not observed_sensitive) and observed_writable

def halo_redundant(action, resource, corruption, rng):
    a = observed_metadata(resource, corruption, rng)
    b = observed_metadata(resource, corruption, rng)
    if a != b:
        return action.requested_op == "read"
    return deterministic(action, *a)

def run(seed=0, corruption=0.0, n=20000):
    rng = random.Random(seed)
    stats = {k: {"unsafe_total": 0, "unsafe_allowed": 0, "safe_total": 0, "safe_blocked": 0}
             for k in ("model_monitor", "deterministic", "halo_redundant")}
    for i in range(n):
        resource = Resource(i, rng.random() < 0.30, rng.random() < 0.70)
        action = Action(i, "write" if rng.random() < 0.55 else "read")
        truth = ground_truth_allow(action, resource)
        obs = observed_metadata(resource, corruption, rng)
        decisions = {
            "model_monitor": model_monitor(action, *obs, rng),
            "deterministic": deterministic(action, *obs),
            "halo_redundant": halo_redundant(action, resource, corruption, rng),
        }
        for name, allow in decisions.items():
            s = stats[name]
            if truth:
                s["safe_total"] += 1
                if not allow:
                    s["safe_blocked"] += 1
            else:
                s["unsafe_total"] += 1
                if allow:
                    s["unsafe_allowed"] += 1
    out = {}
    for name, s in stats.items():
        out[name] = {
            "containment_failure_rate": s["unsafe_allowed"] / s["unsafe_total"],
            "false_block_rate": s["safe_blocked"] / s["safe_total"],
            "benign_success_rate": 1 - s["safe_blocked"] / s["safe_total"],
        }
    return out
