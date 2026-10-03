# NVIDIA NIM planner

HALO can call NVIDIA's hosted OpenAI-compatible chat API as a planner. It uses
`https://integrate.api.nvidia.com/v1/chat/completions` with a bearer key. The
endpoint is fixed by the host; page/model output cannot change it. Redirects
are rejected, and no tool/function definitions are sent.

## Enable

Set `NVIDIA_API_KEY` in the environment of the HALO host, then start the app.
Choose NVIDIA in Settings or choose one of its models in the model picker:

- DeepSeek V4 Flash (`deepseek-ai/deepseek-v4-flash`, default)
- DeepSeek V4 Pro (`deepseek-ai/deepseek-v4-pro`)
- Kimi K3 (`moonshotai/kimi-k3`)
- Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`)

The key only goes to the selected built-in NVIDIA worker. It is not stored in
settings, renderer state, planner prompts, or error messages. Custom operator
workers do not receive it automatically. Model availability depends on the
NVIDIA account. Desktop CLI login is not required.

## Execution and limits

The worker shares the existing HALO JSONL protocol, prompt construction,
proposal/room-turn validation and request-correlated failure handling. Browser,
MCP and other actions still run through HALO policy, approval and execution.

Requests are non-streaming, capped at 8,192 output tokens and use a 55-second
deadline. Response bodies are capped at 1 MiB. Cancellation aborts the HTTP
request; concurrent requests on one bridge are rejected. 401/403, 429, server
errors, truncated responses and invalid proposals fail without automatic retry.
Truncated output or unsolicited tool calls are never dispatched. Fast mode and
model-specific API reasoning-effort options are not passed in this version.

Reported prompt/completion tokens and call duration enter the NVIDIA usage row.
The API response does not supply a billed USD amount here, so the UI says
`Cost not reported`; zero internal cost accounting does not mean a free call.

Synthetic response tests and a real loopback HTTP fixture verify this contract.
They make no paid NVIDIA call. Task context sent by this provider is processed
by NVIDIA's hosted service. Account authentication and live model inference
need a configured NVIDIA key and are separate from the local fixture result.

Official catalog and API reference, checked 2026-10-03:
https://docs.api.nvidia.com/nim/reference/llm-apis
