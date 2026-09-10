# HALO paper-derived attack coverage

This document records literature-derived regression families used to stress the HALO Core/Enforcement trust boundary. The suite currently contains **64 sanitized attack families**.

The suite intentionally does **not** reproduce exploit prompts, harmful payloads, or attack-generation recipes. Each paper-derived family is reduced to the security property relevant to HALO: whether attacker-controlled influence can become trusted control state, exceed an authenticated capability, or change a resource/tool descriptor after approval.

## Security assertions

Every listed family is tested against three common properties:

1. attacker-controlled influence cannot become trusted `subject`, `operation`, or `resource` control provenance;
2. untrusted content is not blocked merely for being untrusted when it does not influence trusted control state;
3. the full `HALOEnforcer.pre()` path denies the action when attacker-controlled influence reaches the control plane, even when policy would otherwise allow the request.

Tool/descriptor mutation families additionally exercise `resource_binding_invariant()`.

## Provenance classes

Trusted-by-default control origins are `runtime`, `user_intent`, and `trusted_plan`. The suite treats `model`, `tool_output`, `external_data`, `memory`, `retrieval`, `mcp_descriptor`, `peer_agent`, and `perception` as untrusted control origins unless a deployment explicitly changes policy. These labels must be assigned by trusted runtime instrumentation.

## Original 30 families

| Family | Origin | Literature basis |
| --- | --- | --- |
| `jailbroken_competing_objectives` | model | Wei et al., *Jailbroken: How Does LLM Safety Training Fail?* |
| `gcg_adversarial_suffix` | model | Zou et al., universal/transferable adversarial suffix work |
| `amplegcg_generated_suffixes` | model | Liao & Sun, AmpleGCG |
| `autodan_semantic_search` | model | Liu et al., AutoDAN |
| `pair_iterative_refinement` | model | Chao et al., PAIR |
| `tap_tree_search` | model | Mehrotra et al., TAP |
| `many_shot_long_context` | model | Anil et al., many-shot jailbreaking |
| `artprompt_representation_obfuscation` | model | Jiang et al., ArtPrompt |
| `best_of_n_input_augmentation` | model | Hughes et al., Best-of-N Jailbreaking |
| `deepinception_nested_scene` | model | Li et al., DeepInception |
| `renellm_rewrite_and_nesting` | model | Ding et al., ReNeLLM |
| `flipattack_input_transformation` | model | Liu et al., FlipAttack |
| `masterkey_automated_jailbreak` | model | Deng et al., MasterKey |
| `gptfuzzer_mutation_search` | model | Yu et al., GPTFuzzer |
| `fuzzllm_combo_fuzzing` | model | Yao et al., FuzzLLM |
| `cognitive_overload` | model | Xu et al., Cognitive Overload |
| `pap_persuasion` | model | Zeng et al., persuasive adversarial prompting |
| `cipherchat_non_natural_encoding` | model | Yuan et al., CipherChat |
| `crescendo_multiturn_escalation` | model | Russinovich et al., Crescendo |
| `direct_prompt_injection` | model | prompt-injection literature |
| `indirect_prompt_injection` | external_data | Greshake et al., indirect prompt injection |
| `houyi_context_partition` | external_data | Liu et al., HouYi |
| `bipia_data_instruction_confusion` | external_data | Yi et al., BIPIA |
| `instruction_hierarchy_low_privilege_override` | tool_output | Wallace et al., Instruction Hierarchy |
| `struq_data_channel_instruction` | external_data | Chen et al., StruQ |
| `injecagent_tool_output_injection` | tool_output | Zhan et al., InjecAgent |
| `agentdojo_tool_output_injection` | tool_output | Debenedetti et al., AgentDojo |
| `asb_memory_poisoning` | memory | Agent Security Bench |
| `asb_plan_backdoor` | model | Agent Security Bench |
| `asb_mixed_attack` | external_data | Agent Security Bench |

## Additional 26 families

| Family | Origin | Literature basis |
| --- | --- | --- |
| `agentpoison_memory_backdoor` | memory | *AgentPoison* (arXiv:2407.12784) |
| `agentpoison_rag_knowledge_base_backdoor` | retrieval | *AgentPoison* (arXiv:2407.12784) |
| `sleeper_memory_delayed_reactivation` | memory | *Hidden in Memory* (arXiv:2605.15338) |
| `mpbench_untrusted_input_memory_write` | memory | MPBench / *From Untrusted Input to Trusted Memory* (arXiv:2606.04329) |
| `poisonedrag_knowledge_corruption` | retrieval | *PoisonedRAG* (arXiv:2402.07867) |
| `badrag_retrieval_backdoor` | retrieval | *BadRAG* (arXiv:2406.00083) |
| `pidp_compound_retrieval_injection` | retrieval | *PIDP-Attack* (arXiv:2603.25164) |
| `mcp_tool_poisoning` | mcp_descriptor | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_tool_shadowing` | mcp_descriptor | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_rug_pull_descriptor_mutation` | mcp_descriptor | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_capability_attestation_spoofing` | mcp_descriptor | *Breaking the Protocol* (arXiv:2601.17549) |
| `mcp_sampling_origin_injection` | mcp_descriptor | *Breaking the Protocol* (arXiv:2601.17549) |
| `mcp_multiserver_trust_propagation` | mcp_descriptor | *Breaking the Protocol* (arXiv:2601.17549) |
| `prompt_infection_cross_agent` | peer_agent | *Prompt Infection* (arXiv:2410.07283) |
| `agent_smith_infectious_multimodal` | peer_agent | *Agent Smith* (arXiv:2402.08567) |
| `multiagent_robot_cross_agent_propagation` | peer_agent | *When Prompts Control Robots* (arXiv:2608.00747) |
| `multiagent_robot_perception_injection` | perception | *When Prompts Control Robots* (arXiv:2608.00747) |
| `wasp_web_agent_page_injection` | perception | *WASP* (arXiv:2504.18575) |
| `mirage_gui_user_content_injection` | perception | *MIRAGE* (arXiv:2605.28116) |
| `crossinject_cross_modal_injection` | perception | cross-modal prompt-injection work (arXiv:2504.14348) |
| `imperceptible_visual_prompt_injection` | perception | multimodal adversarial prompt-injection work (arXiv:2603.29418) |
| `agentlab_intent_hijacking` | external_data | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_tool_chaining` | tool_output | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_task_injection` | external_data | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_objective_drifting` | external_data | *AgentLAB* (arXiv:2602.16901) |
| `adaptive_multiround_pivoting` | external_data | adaptive adversary work (arXiv:2607.18063) |

## Extended 8 families

| Family | Origin | Structural surface |
| --- | --- | --- |
| `memmorph_memory_tool_selection_hijack` | memory | retrieved memory influencing tool selection |
| `memorygraft_experience_imitation_poisoning` | memory | poisoned past experience influencing procedural imitation |
| `audioagent_concurrent_audio_injection` | perception | concurrent audio-derived instructions crossing into control |
| `planflip_goal_substitution` | tool_output | planning-stage goal replacement |
| `planflip_priority_inversion` | tool_output | planning-stage priority inversion |
| `planflip_context_pollution` | tool_output | planning context contamination |
| `planflip_role_confusion` | tool_output | planning-stage authority/role confusion |
| `promptshield_ambient_command_source_ambiguity` | perception | ambient-command source ambiguity |

These extended cases remain sanitized structural labels; no attack prompt or generation recipe is stored in the repository.

## Design implications

The coverage exercises three reusable HALO invariants:

- `control_provenance_invariant()` requires security-sensitive control fields to derive only from configured trusted origins;
- `capability_scope_invariant()` requires authenticated runtime capability metadata to authorize the action subject, operation, and resource;
- `resource_binding_invariant()` requires a runtime-observed SHA-256 descriptor/resource digest to match the approved digest.

The enforcement layer additionally authenticates the canonical digest of the complete `Action`, so a valid envelope cannot be reused for a different subject/operation/resource/attribute set that happens to share an action ID.

This follows the broad design direction of capability/provenance-based defenses such as CaMeL: untrusted data may be processed, but it must not silently become control flow or expand authority.

A 2026 survey synthesizing 247 papers likewise highlights information flow, delegated authority, persistent state, prompt injection, tool-mediated control-flow hijacking, and multi-agent propagation as central agent-security surfaces (*Toward Secure LLM Agents: Threat Surfaces, Attacks, Defenses, and Evaluation*, arXiv:2606.10749).

## Scope limits

These tests are **structural containment regressions**, not claims that HALO detects or prevents the underlying model from being jailbroken. The model is intentionally treated as potentially compromised.

The guarantees depend on trusted runtime instrumentation assigning provenance correctly, computing resource/action digests correctly, generating non-reused telemetry sessions, and keeping authentication keys outside the untrusted model boundary. If the model can forge trusted provenance, forge authenticated telemetry, or bypass the protected adapter, these regressions do not provide a security guarantee.
