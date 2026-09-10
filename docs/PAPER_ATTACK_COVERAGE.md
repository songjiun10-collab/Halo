# HALO paper-derived attack coverage

This document records literature-derived regression families used to stress the HALO Core/Enforcement trust boundary.

The suite intentionally does **not** reproduce exploit prompts, harmful payloads, or attack-generation recipes. Each paper-derived family is reduced to the security property relevant to HALO: whether attacker-controlled influence can become trusted control state, exceed an authenticated capability, or change a resource/tool descriptor after approval.

## Security assertions

Every listed family is tested against three common properties:

1. attacker-controlled influence cannot become trusted `subject`, `operation`, or `resource` control provenance;
2. untrusted content is not blocked merely for being untrusted when it does not influence trusted control state;
3. the full `HALOEnforcer.pre()` path denies the action when attacker-controlled influence reaches the control plane, even when the policy layer would otherwise allow the request.

The second assertion is deliberate: a defense that blocks all external data would be safe but useless. HALO instead separates **data use** from **control authority**.

Tool/descriptor mutation families additionally exercise `resource_binding_invariant()`, which requires the runtime-observed SHA-256 descriptor/resource digest to match the digest that was approved.

## Provenance classes

Trusted-by-default control origins are limited to `runtime`, `user_intent`, and `trusted_plan`.

The regression suite treats these as untrusted unless a deployment explicitly changes policy:

- `model`
- `tool_output`
- `external_data`
- `memory`
- `retrieval`
- `mcp_descriptor`
- `peer_agent`
- `perception`

These labels must be assigned by trusted runtime instrumentation. A model or tool cannot self-assert that its own content is trusted.

## Original 30 families

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
| `asb_memory_poisoning` | memory | memory content cannot silently become trusted control | Agent Security Bench |
| `asb_plan_backdoor` | model | compromised plan generation cannot exceed capability scope | Agent Security Bench |
| `asb_mixed_attack` | external_data | mixed attack channels still require trusted provenance | Agent Security Bench |

## Additional 26 families

| Family | Modeled origin | HALO property stressed | Literature basis |
| --- | --- | --- | --- |
| `agentpoison_memory_backdoor` | memory | poisoned long-term memory cannot become authority | *AgentPoison* (arXiv:2407.12784) |
| `agentpoison_rag_knowledge_base_backdoor` | retrieval | retrieved poisoned demonstrations remain data, not authority | *AgentPoison* (arXiv:2407.12784) |
| `sleeper_memory_delayed_reactivation` | memory | dormant cross-session memory cannot silently regain authority | *Hidden in Memory* (arXiv:2605.15338) |
| `mpbench_untrusted_input_memory_write` | memory | untrusted input written to persistent memory stays untrusted | *From Untrusted Input to Trusted Memory* / MPBench (arXiv:2606.04329) |
| `poisonedrag_knowledge_corruption` | retrieval | RAG knowledge corruption cannot redirect protected control | *PoisonedRAG* (arXiv:2402.07867) |
| `badrag_retrieval_backdoor` | retrieval | retrieval backdoors cannot expand action authority | *BadRAG* (arXiv:2406.00083) |
| `pidp_compound_retrieval_injection` | retrieval | combined prompt/retrieval poisoning still lacks control privilege | *PIDP-Attack* (arXiv:2603.25164) |
| `mcp_tool_poisoning` | mcp_descriptor | tool metadata cannot become privileged instruction | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_tool_shadowing` | mcp_descriptor | contaminated tool context cannot redirect trusted tools | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_rug_pull_descriptor_mutation` | mcp_descriptor | post-approval descriptor changes must fail binding | *Securing the Model Context Protocol* (arXiv:2512.06556) |
| `mcp_capability_attestation_spoofing` | mcp_descriptor | server-claimed permissions cannot self-authorize | *Breaking the Protocol* (arXiv:2601.17549) |
| `mcp_sampling_origin_injection` | mcp_descriptor | unauthenticated protocol-origin content cannot become control | *Breaking the Protocol* (arXiv:2601.17549) |
| `mcp_multiserver_trust_propagation` | mcp_descriptor | trust must not transitively spread across MCP servers | *Breaking the Protocol* (arXiv:2601.17549) |
| `prompt_infection_cross_agent` | peer_agent | compromised peer-agent messages stay untrusted | *Prompt Infection* (arXiv:2410.07283) |
| `agent_smith_infectious_multimodal` | peer_agent | infectious multi-agent jailbreak propagation cannot carry authority | *Agent Smith* (arXiv:2402.08567) |
| `multiagent_robot_cross_agent_propagation` | peer_agent | cross-agent contamination cannot become protected control | *When Prompts Control Robots* (arXiv:2608.00747) |
| `multiagent_robot_perception_injection` | perception | perception-module injections remain untrusted evidence | *When Prompts Control Robots* (arXiv:2608.00747) |
| `wasp_web_agent_page_injection` | perception | webpage content cannot become privileged browser-agent control | *WASP* (arXiv:2504.18575) |
| `mirage_gui_user_content_injection` | perception | user-generated GUI content cannot become system authority | *MIRAGE* (arXiv:2605.28116) |
| `crossinject_cross_modal_injection` | perception | cross-modal cues cannot elevate control privilege | *Manipulating Multimodal Agents via Cross-Modal Prompt Injection* (arXiv:2504.14348) |
| `imperceptible_visual_prompt_injection` | perception | hidden visual instructions remain untrusted perception | *Adversarial Prompt Injection Attack on Multimodal Large Language Models* (arXiv:2603.29418) |
| `agentlab_intent_hijacking` | external_data | long-horizon intent drift cannot rewrite trusted objective | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_tool_chaining` | tool_output | chained tool responses cannot compound into extra privilege | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_task_injection` | external_data | injected sub-tasks cannot become trusted task authority | *AgentLAB* (arXiv:2602.16901) |
| `agentlab_objective_drifting` | external_data | gradual objective drift cannot rewrite control provenance | *AgentLAB* (arXiv:2602.16901) |
| `adaptive_multiround_pivoting` | external_data | adaptive attacker pivots still cannot gain authority | *Adaptive Adversaries* (arXiv:2607.18063) |

## Design implications

The coverage now exercises three reusable HALO invariants:

- `control_provenance_invariant()` requires security-sensitive control fields to be derived only from configured trusted origins. Missing, malformed, mixed-trust, unknown, model, retrieval, MCP, peer-agent, perception, tool, memory, and external-data provenance fail closed by default.
- `capability_scope_invariant()` requires authenticated runtime capability metadata to authorize the action subject, operation, and resource.
- `resource_binding_invariant()` requires a runtime-observed SHA-256 descriptor/resource digest to match the approved digest, covering approval-to-use mutation such as MCP descriptor rug pulls.

This follows the broad design direction of capability/provenance-based defenses such as CaMeL: untrusted data may be processed, but it must not silently become control flow or expand authority.

A 2026 survey synthesizing 247 papers similarly highlights information flow, delegated authority, persistent state, prompt injection, tool-mediated control-flow hijacking, and multi-agent propagation as central agent-security surfaces (*Toward Secure LLM Agents: Threat Surfaces, Attacks, Defenses, and Evaluation*, arXiv:2606.10749).

## Scope limits

These tests are **structural containment regressions**, not claims that HALO detects or prevents the underlying model from being jailbroken. The model is intentionally treated as potentially compromised.

The guarantees depend on trusted runtime instrumentation assigning provenance correctly, computing resource digests correctly, generating non-reused telemetry sessions, and keeping authentication keys outside the untrusted model boundary. If the model can forge trusted provenance, forge authenticated telemetry, or bypass the protected adapter, these regressions do not provide a security guarantee.
