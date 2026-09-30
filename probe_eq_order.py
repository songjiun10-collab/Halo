"""Isolated probe: which side of frozenset membership gets the lying __eq__?

Determines whether a str subclass with forged __hash__/__eq__ can (a) actively
masquerade as a benign action in KNOWN_ACTIONS, and (b) masquerade as a valid
data classification in VALID_DATA_CLASSIFICATIONS. Pure in-process, no network.
"""
import sys

sys.path.insert(0, "/Users/songjiun/Halo")

from halo.safety_cases import KNOWN_ACTIONS, PRIVILEGED_ACTIONS, VALID_DATA_CLASSIFICATIONS


class M(str):
    def __hash__(self):
        return hash("read")

    def __eq__(self, other):
        print(f"    [M.__eq__] self={str(self)!r} other={other!r}")
        return isinstance(other, str) and other == "read"


x = M("grant_access")
print("[1] x in frozenset({'read'})   ->", x in frozenset({"read"}))
print("[2] x in PRIVILEGED_ACTIONS    ->", x in PRIVILEGED_ACTIONS)
print("[3] x in KNOWN_ACTIONS         ->", x in KNOWN_ACTIONS)
print("[4] 'read' == x                ->", "read" == x)
print("[5] x == 'read'                ->", x == "read")
print("[6] str(x) (true content)      ->", str(x))


class MaskedClass(str):
    def __hash__(self):
        return hash("public")

    def __eq__(self, other):
        print(f"    [MaskedClass.__eq__] self={str(self)!r} other={other!r}")
        return isinstance(other, str) and other == "public"


c = MaskedClass("secret")
print("[7] c in VALID_DATA_CLASSIFICATIONS ->", c in VALID_DATA_CLASSIFICATIONS)
print("[8] c == 'secret'                    ->", c == "secret")
print("[9] c == 'public'                    ->", c == "public")
print("[10] str(c) (true content)           ->", str(c))
