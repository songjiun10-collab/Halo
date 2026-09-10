# Prior work

E002 was designed after checking relevant prior work rather than as a standalone novelty claim.

- Koran et al. (2026), *Ensemble Monitoring for AI Control: Diverse Signals Outweigh More Compute* — monitor construction diversity and low correlation can improve detection, while adaptive adversaries, different evidence sources, and the mechanism of complementarity remain open directions.
- Wu & Gong (2026), *Policy-Invisible Violations in LLM-Based Agents* — policy enforcement can fail when decision-relevant world state is absent from the enforcement layer.

E002 combines these ideas in a synthetic stress test: monitors can be diverse on observed attack families while sharing the same held-out missing-evidence blind spot.
