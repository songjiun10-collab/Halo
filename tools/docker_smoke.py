"""Exercise the container's development gateway without printing credentials."""
import hashlib
import http.client
import json
import os
from pathlib import Path


def request(path, key, body):
    connection = http.client.HTTPConnection("127.0.0.1", 8080, timeout=5)
    try:
        connection.request("POST", path, json.dumps(body),
                           {"Content-Type": "application/json", "Authorization": "Bearer " + key})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def main():
    approver = Path(os.environ["HALO_APPROVER_KEY_FILE"]).read_text().strip()
    executor = Path(os.environ["HALO_EXECUTOR_KEY_FILE"]).read_text().strip()
    status, grant = request("/approve", approver,
        {"tool": "sha256", "args": {"text": "hello"}, "intent_id": "docker-local-smoke"})
    if status != 200 or "token" not in grant:
        raise RuntimeError("Approval failed")
    body = {"tool": "sha256", "args": {"text": "hello"}, "token": grant["token"]}
    status, _ = request("/execute", approver, body)
    if status != 403:
        raise RuntimeError("Role isolation failed")
    status, result = request("/execute", executor, body)
    if status != 200 or result.get("sha256") != hashlib.sha256(b"hello").hexdigest():
        raise RuntimeError("Execution failed")
    status, _ = request("/execute", executor, body)
    if status != 403:
        raise RuntimeError("Replay refusal failed")
    print("PASS: approval, role isolation, SHA-256 execution, replay refusal")


if __name__ == "__main__":
    main()
