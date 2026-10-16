"""Scores Halo runs with the ORIGINAL WebArena evaluators (web-arena-x/webarena).

Usage (inside a venv that has the webarena requirements):
  python original_eval.py --webarena-dir <clone> --results <run out dir> \
      --tasks <clone>/config_files/test.raw.json --state-dir <clone>/.auth --out score.json

Per task dir `<results>/<id>/original.json` (written by webarena-run.js) holds the
final answer and the final URL. The evaluator is called exactly as in the
original run.py: trajectory ends in a STOP action carrying the answer, and
`page` is a browser page that has loaded the final URL with the task's login
state. The only change: the LLM judge for `fuzzy_match` / unachievable-reason
checks calls the local `codex exec` (ChatGPT subscription) instead of the
OpenAI API; set HALO_JUDGE_MODEL to pin a model.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SITE_ENV = {
    "SHOPPING": "http://localhost:7770", "SHOPPING_ADMIN": "http://localhost:7780",
    "REDDIT": "http://localhost:9999", "GITLAB": "http://localhost:8023",
    "WIKIPEDIA": "http://localhost:8888", "MAP": "http://localhost:3000", "HOMEPAGE": "http://localhost:4399",
}
for key, value in SITE_ENV.items():
    os.environ.setdefault(key, value)


def codex_judge(prompt: str) -> str:
    out = Path(tempfile.mkstemp(suffix=".txt")[1])
    cmd = ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-o", str(out)]
    if os.environ.get("HALO_JUDGE_MODEL"):
        cmd += ["-m", os.environ["HALO_JUDGE_MODEL"]]
    subprocess.run(cmd + [prompt], capture_output=True, text=True, timeout=300, check=False)
    text = out.read_text().strip()
    out.unlink(missing_ok=True)
    return text


def llm_fuzzy_match(pred: str, reference: str, question: str) -> float:
    # Same prompt as the original helper_functions.llm_fuzzy_match.
    message = (
        "Help a teacher to grade the answer of a student given a question. Keep in mind that the student may use different phrasing or wording to answer the question. The goal is to evaluate whether the answer is semantically equivalent to the reference answer.\n"
        f"question: {question}\nreference answer: {reference}\n"
        "all the string 'N/A' that you see is a special sequence that means 'not achievable'\n"
        f"student answer: {pred}\nConclude the judgement by correct/incorrect/partially correct."
    )
    response = codex_judge(message).lower()
    if "partially correct" in response or "incorrect" in response:
        return 0.0
    return 1.0 if "correct" in response else 0.0


def llm_ua_match(pred: str, reference: str, question: str) -> float:
    message = (
        f"task: {question}\nactual unachievable reason: {reference}\nreported unachievable reason: {pred}\n"
        "The task described above is inherently unachievable due to the reason specified under 'actual unachievable reason'. "
        "An individual previously attempted this task and was unable to complete it. They provided a reason for their failure, "
        "which is listed under 'reported unachievable reason'. Judge whether the reported reason aligns with the actual reason. "
        "Conclude the judgement by correct/incorrect."
    )
    response = codex_judge(message).lower()
    return 1.0 if "correct" in response and "incorrect" not in response else 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--webarena-dir", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    sys.path.insert(0, args.webarena_dir)
    from playwright.sync_api import sync_playwright
    import evaluation_harness.evaluators as ev
    from browser_env.actions import create_stop_action

    ev.llm_fuzzy_match = llm_fuzzy_match
    ev.llm_ua_match = llm_ua_match

    tasks = {str(t["task_id"]): t for t in json.loads(Path(args.tasks).read_text())}
    results = Path(args.results)
    scores = {}
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
        browser = pw.chromium.launch(headless=True)
        for run_file in sorted(results.glob("*/original.json")):
            task_id = run_file.parent.name
            run = json.loads(run_file.read_text())
            raw = json.dumps(tasks[task_id])
            for token, url in (("__SHOPPING_ADMIN__", SITE_ENV["SHOPPING_ADMIN"]), ("__SHOPPING__", SITE_ENV["SHOPPING"]),
                               ("__REDDIT__", SITE_ENV["REDDIT"]), ("__GITLAB__", SITE_ENV["GITLAB"]),
                               ("__WIKIPEDIA__", SITE_ENV["WIKIPEDIA"]), ("__MAP__", SITE_ENV["MAP"])):
                raw = raw.replace(token, url)
            config = Path(tmp) / f"{task_id}.json"
            config.write_text(raw)
            task = json.loads(raw)
            state = Path(args.state_dir) / Path(task.get("storage_state") or "x").name
            try:
                context = browser.new_context(storage_state=str(state)) if state.exists() else browser.new_context()
                page = context.new_page()
                try:
                    page.goto(run["final_url"] or task["start_url"], timeout=60000)
                except Exception:
                    pass
                client = context.new_cdp_session(page)
                trajectory = [{}, create_stop_action(run.get("answer", ""))]
                evaluator = ev.evaluator_router(config)
                score = float(evaluator(trajectory=trajectory, config_file=config, page=page, client=client))
                context.close()
                error = None
            except Exception as exc:  # an evaluator crash is reported, never silently scored as a pass
                score, error = 0.0, f"{type(exc).__name__}: {exc}"[:300]
            scores[task_id] = {"score": score, "eval_types": task["eval"]["eval_types"], "answer": run.get("answer"),
                               "final_url": run.get("final_url"), "state": run.get("state"), "error": error}
            print(task_id, score, error or "", flush=True)
        browser.close()

    total = len(scores)
    passed = sum(1 for item in scores.values() if item["score"] >= 1.0)
    summary = {"total": total, "passed": passed, "pass_rate": passed / total if total else 0.0, "tasks": scores}
    Path(args.out).write_text(json.dumps(summary, indent=2))
    print(f"passed {passed}/{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
