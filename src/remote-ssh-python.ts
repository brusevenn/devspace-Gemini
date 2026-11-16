// Small remote Python helper transported over SSH stdin. No files are installed on the host.
export const REMOTE_HELPER = String.raw`import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

request = json.loads(base64.b64decode("__PAYLOAD__"))
root = Path(request["root"]).resolve(strict=True)
if not root.is_dir() or str(root) == "/":
    raise ValueError("Remote project root must be an existing non-root directory")

def confined(relative, for_write=False):
    if not isinstance(relative, str) or relative.startswith("/") or "\\" in relative or "\x00" in relative:
        raise ValueError("Expected a relative POSIX path inside the remote project")
    parts = Path(relative).parts
    if not parts or ".." in parts or ".git" in parts:
        raise ValueError("Path traversal and .git mutations are not allowed")
    target = (root / relative).resolve(strict=not for_write)
    if os.path.commonpath([str(root), str(target)]) != str(root):
        raise ValueError("Path is outside the configured remote project")
    return target

def digest(contents):
    return hashlib.sha256(contents).hexdigest()

def write_atomic(target, contents):
    if len(contents) > 1024 * 1024:
        raise ValueError("Write exceeds the 1 MiB file limit")
    if not target.parent.is_dir():
        raise ValueError("Parent directory does not exist")
    original_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=".devspace-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, original_mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def operate(req=None):
    req = request if req is None else req
    op = req["op"]

    if op in ("read_batch", "apply_batch"):
        operations = req.get("operations")
        allowed = {"read", "status"} if op == "read_batch" else {"write", "edit"}
        if not isinstance(operations, list) or not 1 <= len(operations) <= 20:
            raise ValueError("Batch must contain between 1 and 20 operations")
        if any(not isinstance(item, dict) or item.get("op") not in allowed for item in operations):
            raise ValueError("Batch contains an unsupported operation")
        if op == "apply_batch":
            paths = [item.get("path") for item in operations]
            if len(paths) != len(set(paths)):
                raise ValueError("A file may appear only once in an apply batch")
        results = []
        for index, item in enumerate(operations):
            try:
                results.append({"index": index, "ok": True, **operate(item)})
            except Exception as exc:
                results.append({"index": index, "ok": False, "error": str(exc)})
                return {"result": json.dumps({
                    "results": results,
                    "completed": index,
                    "failed_at": index,
                    "partial": index > 0
                }, ensure_ascii=False)}
        return {"result": json.dumps({
            "results": results,
            "completed": len(results),
            "partial": False
        }, ensure_ascii=False)}

    if op == "open":
        result = {"result": "Remote SSH project is accessible: " + str(root)}
        agents = root / "AGENTS.md"
        if agents.is_file():
            agents = agents.resolve(strict=True)
            if os.path.commonpath([str(root), str(agents)]) == str(root) and agents.stat().st_size <= 16384:
                result["result"] += "\nRoot AGENTS.md:\n" + agents.read_text(encoding="utf-8")
        return result

    if op == "read":
        target = confined(req["path"])
        if not target.is_file():
            raise ValueError("Requested path is not a regular file")
        if target.stat().st_size > 1024 * 1024:
            raise ValueError("File exceeds 1 MiB; read a smaller file")
        contents = target.read_bytes()
        text = contents.decode("utf-8")
        offset = req.get("offset", 1)
        limit = req.get("limit", 400)
        lines = text.splitlines(keepends=True)
        excerpt = "".join(lines[offset - 1:offset - 1 + limit])
        return {"result": excerpt, "sha256": digest(contents)}

    if op in ("write", "edit"):
        target = confined(req["path"], for_write=True)
        previous = target.read_bytes() if target.exists() else None
        expected = req.get("expected_sha256")
        if previous is not None and expected != digest(previous):
            raise ValueError("File changed or missing expected_sha256; read it again before editing")
        if previous is None and expected is not None:
            raise ValueError("File no longer exists in the expected state")
        if op == "write":
            contents = req["content"].encode("utf-8")
        else:
            if previous is None:
                raise ValueError("Cannot edit a missing file")
            text = previous.decode("utf-8")
            for edit in req["edits"]:
                old = edit["old_text"]
                if not old or text.count(old) != 1:
                    raise ValueError("Each old_text must match exactly once")
                text = text.replace(old, edit["new_text"], 1)
            contents = text.encode("utf-8")
        write_atomic(target, contents)
        return {"result": "Updated " + req["path"], "sha256": digest(contents), "changed": previous != contents}

    if op == "exec":
        cwd = root if req.get("cwd") in (None, "", ".") else confined(req["cwd"])
        if not cwd.is_dir():
            raise ValueError("Working directory is not a directory")
        completed = subprocess.run(
            ["bash", "-lc", req["command"]],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=req.get("timeout", 30),
            check=False
        )
        output = completed.stdout[:128000].decode("utf-8", errors="replace")
        return {"result": output + "\nExit code: " + str(completed.returncode), "exit_code": completed.returncode}

    if op == "status":
        completed = subprocess.run(
            ["git", "status", "--short", "--branch"],
            cwd=str(root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
            check=False
        )
        return {"result": completed.stdout[:128000].decode("utf-8", errors="replace"), "exit_code": completed.returncode}
    raise ValueError("Unknown remote operation")

try:
    print(json.dumps({"ok": True, "data": operate()}), flush=True)
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
`;
