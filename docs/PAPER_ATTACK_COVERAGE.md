# HALO paper-derived attack coverage

This document records literature-derived regression families used to stress the HALO Core/Enforcement trust boundary.

The suite intentionally does **not** reproduce exploit prompts, harmful payloads, or attack-generation recipes. Each paper-derived family is reduced to the security property relevant to HALO: whether attacker-controlled influence from the model, tool output, external data, or memory can become trusted control state or exceed an authenticated capability.

## Security assertions

Every listed family is tested against three properties:

1. attacker-controlled influence cannot become trusted `subject`, `operation`, or `resource` control provenance;
2. untrusted content is not blocked merely for being untrusted when it does not influence trusted control state;
3. the full `HALOEnforcer.pre()` path denies the action when attacker-controlled influence reaches the control plane, even when the policy layer would otherwise allow the request.

The second assertion is deliberate: a defense that blocks all external data would be safe but useless. HALO instead tries to separate **data use** from **control authority**.

## Covered families

| Family | Modeled origin | HALO property stressed | Literature basis |
| --- | --- | --- | --- |
| `jailbroken_competing_objectives` | model | model compromise must not imply authorization | Wei et al., *Jailbroken: How Does LLM Safety Training Fail?* |
| `gcg_adversarial_suffix` | model | adversarial model output cannot cross the reference-monitor boundary | Zou et al., universal/transferable adversarial suffix work |
| `amplegcg_generated_suffixes` | model | scaled/generated suffix variation does not change authority | Liao & Sun, AmpleGCG |
| `autodan_semantic_search` | model | semantically natural jailbreak variation cannot grant authority | Liu et al., AutoDAN |
| `pair_iterative_refinement` | model | iterative attacker-model refinement cannot grant authority | Chao et al., PAIR |
| `tap_tree_search` | model | search over attack variants cannot grant authority | Mehrotra et al., TAP |
| `many_shot_long_context` | model | long-context steering cannot grant authority | Anil et al., many-shot jailbreaking |
| `artprompt_representation_obfuscation` | model | representation changes cannot grant authority | Jiang et al., ArtPrompt |
| `best_of_n_input_augmentation` | model | repeated transformed attempts cannot grant authority | Hughes et al., Best-of-N Jailbreaking |
| `deepinception_nested_scene` | model | nested-role framing cannot grant authority | Li et al., DeepInception |
| `renellm_rewrite_and_nesting` | model | rewrite/scenario nesting cannot grant authority | Ding et al., ReNeLLM |
| `flipattack_input_transformation` | model | transformed input representations cannot grant authority | Liu et al., FlipAttack |
| `masterkey_automated_jailbreak` | model | automated jailbreak generation cannot grant authority | Deng et al., MasterKey |
| `gptfuzzer_mutation_search` | model | fuzzed prompt mutations cannot grant authority | Yu et al., GPTFuzzer |
| `fuzzllm_combo_fuzzing` | model | composed fuzzing strategies cannot grant authority | Yao et al., FuzzLLM |
| `cognitive_overload` | model | overloaded reasoning/representation does not grant authority | Xu et al., Cognitive Overload |
| `pap_persuasion` | model | persuasive steering cannot grant authority | Zeng et al., persuasive adversarial prompting |
| `cipherchat_non_natural_encoding` | model | alternate encodings do not grant authority | Yuan et al., CipherChat |
| `crescendo_multiturn_escalation` | model | gradual multi-turn steering cannot grant authority | Russinovich et al., Crescendo |
| `direct_prompt_injection` | model | lower-trust instructions cannot rewrite control state | prompt-injection literature |
| `indirect_prompt_injection` | external_data | retrieved data cannot become executable authority | Greshake et al., indirect prompt injection |
| `houyi_context_partition` | external_data | context partitioning cannot promote data into control | Liu et al., HouYi |
| `bipia_data_instruction_confusion` | external_data | data/instruction ambiguity cannot promote data into control | Yi et al., BIPIA |
| `instruction_hierarchy_low_privilege_override` | tool_output | lower-privilege tool text cannot override higher-level control | Wallace et al., Instruction Hierarchy |
| `struq_data_channel_instruction` | external_data | data-channel instructions cannot become control authority | Chen et al., StruQ |
| `injecagent_tool_output_injection` | tool_output | tool-returned text cannot redirect privileged actions | Zhan et al., InjecAgent |
| `agentdojo_tool_output_injection` | tool_output | untrusted tool data cannot redirect tool execution | Debenedetti et al., AgentDojo |
| `asb_memory_poisoning` | memory | memory content cannot silently become trusted control | Zhang et al., Agent Security Bench |
| `asb_plan_backdoor` | model | compromised plan generation cannot exceed capability scope | Zhang et al., Agent Security Bench |
| `asb_mixed_attack` | external_data | mixed attack channels still require trusted provenance | Zhang et al., Agent Security Bench |

## Design implications

The coverage above supports two reusable HALO invariants:

- `control_provenance_invariant()` requires security-sensitive control fields to be derived only from configured trusted origins. Missing, malformed, mixed-trust, or unknown provenance fails closed.
- `capability_scope_invariant()` requires authenticated runtime capability metadata to authorize the action subject, operation, and resource.

This follows the same broad design direction as capability/provenance-based prompt-injection defenses such as CaMeL: untrusted data may be processed, but it must not silently become control flow or expand authority.

## Scope limits

These tests are **structural containment regressions**, not claims that HALO detects or prevents the underlying model from being jailbroken. The model is intentionally treated as potentially compromised.

The guarantees also depend on trusted runtime instrumentation assigning provenance correctly and keeping telemetry/authentication keys outside the untrusted model boundary. If the model can forge trusted provenance or bypass the protected adapter, these regressions do not provide a security guarantee.
