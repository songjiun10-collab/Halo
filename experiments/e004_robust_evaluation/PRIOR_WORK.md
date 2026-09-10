# Prior work — E004 robust evaluation

E004 is a replication/extension-style sanity test, not a novelty claim.

Closest references:

- Souly et al. (2024), **A StrongREJECT for Empty Jailbreaks** — shows that weak automated jailbreak evaluators can substantially overstate attack success and argues for evaluation that tracks whether outputs actually satisfy harmful requests. https://arxiv.org/abs/2402.10260
- Chao et al. (2024), **JailbreakBench: An Open Robustness Benchmark for Jailbreaking Large Language Models** — standardizes threat models, artifacts, datasets, and scoring so attack/defense results are comparable. https://arxiv.org/abs/2404.01318
- Zizzo et al. (2025), **Adversarial Prompt Evaluation: Systematic Benchmarking of Guardrails Against Prompt Input Attacks on LLMs** — reports substantial guardrail performance variation across attack styles and evaluates both malicious and benign datasets, motivating subgroup and utility measurements rather than a single aggregate safety number. https://arxiv.org/abs/2502.15427

## What E004 isolates

The experiment intentionally removes language-model and prompt-content complexity. It asks a narrower measurement question: if one attack family is much easier than another, can an aggregate metric hide the weak family, and what benign false-positive cost is paid when threshold selection explicitly protects the worst attack subgroup?

This does not establish that worst-group thresholding is the right deployment policy. It only demonstrates why HALO evaluations should report at least benign false-positive rate, per-family TPR, worst-family TPR, and distribution-shift sensitivity alongside aggregate attack detection.
