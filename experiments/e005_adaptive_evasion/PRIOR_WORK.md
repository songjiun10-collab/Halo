# Prior work

E005 was designed after reviewing relevant prior work rather than as a standalone novelty claim.

- Goodfellow et al. (2015), *Explaining and Harnessing Adversarial Examples* — small, invisible input perturbations can flip a classifier's decision; motivates studying adversaries that shape *content* rather than corrupting *metadata* (which E001–E004 handled).
- Papernot et al. (2017), *Practical Black-Box Attacks against Machine Learning* — target models can be attacked using only input/output labels, no gradients; motivates the binary allow/block feedback assumption.
- Koran et al. (2026), *Ensemble Monitoring for AI Control* — names adaptive adversaries and moving evidence sources as open directions for monitor ensembles; E005 isolates one such direction in a synthetic loop.

E005 contributes the sequential/adaptive dimension that the existing static HALO experiments omit: it stresses the assumption that a *static* monitor boundary stays effective when the contained model can query and adapt, and it records that a naive moving-target defense trades mean effect for variance rather than reliably closing the gap.