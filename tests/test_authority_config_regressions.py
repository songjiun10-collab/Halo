from halo import Action, InvariantEngine, Phase, attribute_authorization_invariant
from halo.types import CheckStatus


def test_unknown_attribute_constraint_group_fails_closed():
    current = Action(
        "authority-config",
        "worker",
        "send",
        "service",
        {"tenant": "demo", "count": 1},
    )
    payload = {
        "attribute_authorization": {
            "exact": {"tenant": "demo"},
            "numeric_mx": {"count": 1},
        }
    }
    check = InvariantEngine([attribute_authorization_invariant()]).evaluate(
        current, Phase.PRE, payload
    )[0]
    assert check.status is CheckStatus.FAIL
