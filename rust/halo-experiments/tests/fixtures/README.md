# Deterministic Python reference fixtures

Generated on 2026-09-12 from the working Python implementations, before Rust comparison. Test execution reads JSON directly and never starts Python.

- `e002_reference.json`: 10 fixed-score pooling and quantile examples, including tied scores and FPR endpoints. Python source SHA-256: `50173d1b84277444d55f0f4e44d035e3f8cd7aefcb575506bacb698cf3e8935a`.
- `e004_reference.json`: 27 metric and selector examples, including threshold equality, imbalanced groups, explicit balancing, and finite weights of `1e308`. Python source SHA-256: `14f86133c7176906fb68bb005745566f37e0ae71c402664b71613a17092963d2`.

These references check deterministic arithmetic semantics, not equality of random number streams or a blanket correctness claim about the Python models.
